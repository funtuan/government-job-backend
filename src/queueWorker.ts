import { stringifyData } from "./cronHandler";
import { sendEmail } from "./utils/email";

export const queueWorker = async (batch, env): Promise<void> => {
  let messages = JSON.stringify(batch.messages);
  console.log(`consumed from our queue: ${messages}`);

  for (const message of batch.messages) {
    const {
      id: configId,
      matchedJobs,
      notifyConfig,
    } = message.body

    try {
      const text = matchedJobs
        .slice(0, 10)
        .map((job) => stringifyData(job.fields))
        .join('\n\n=======================\n\n')

      const id = Math.random().toString(36).substring(2, 15)
      const viewUrl = `${env.BACKEND_HOST}/view/${id}`
      await env.kv.put(`view:${id}`, JSON.stringify(matchedJobs), {
        expirationTtl: 60 * 60 * 24 * 7, // 7 days
      })

      const unsubscribeUrl = `${env.BACKEND_HOST}/unsubscribe/${configId}`
      const systemContent = `設定其他條件 ${env.FRONTEND_HOST}\n取消訂閱 ${unsubscribeUrl}`

      let summary = ''
      if (matchedJobs.length > 10) {
        summary = `今日符合職缺共 ${matchedJobs.length} 筆，以上只顯示前 10 筆\n${viewUrl}\n\n${systemContent}`
      } else {
        summary = `今日符合職缺共 ${matchedJobs.length} 筆，以上為全部\n${viewUrl}\n\n${systemContent}`
      }

      const fullText = `${text}\n\n=======================\n\n${summary}`

      await sendEmail(
        env,
        notifyConfig.email,
        `事求人 - 今日新職缺通知`,
        fullText,
        fullText.replace(/\n/g, '<br>'),
      )
    } catch (error) {
      // 寄信失敗，刪除 notifyConfig
      if (message.attempts === 4) {
        console.log('send email failed', configId)
        await env.DB.prepare(`DELETE FROM notify_config WHERE id = ?`).bind(configId).run()
      }
      throw error
    }
  }
}