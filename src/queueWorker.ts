import { stringifyData } from "./cronHandler";
import { sendLineNotify } from "./utils/lineNotify";

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
      for (let i = 0; i < Math.min(matchedJobs.length, 10); i++) {
        console.log('sendLineNotify', stringifyData(matchedJobs[i].fields))
        await sendLineNotify(
          stringifyData(matchedJobs[i].fields),
          notifyConfig.lineNotifyToken,
        )
      }
    } catch (error) {
      // 如果被解除授權，刪除 notifyConfig
      if (message.attempts === 4) {
        if (error.message.includes('Invalid access token')) {
          console.log('Invalid access token', configId)
          await env.DB.prepare(`DELETE FROM notify_config WHERE id = ?`).bind(configId).run()
        }
      }
      throw error
    }
  
    // 隨機產生 id
    const id = Math.random().toString(36).substring(2, 15)
    const viewUrl = `${env.BACKEND_HOST}/view/${id}`
    await env.kv.put(`view:${id}`, JSON.stringify(matchedJobs), {
      expirationTtl: 60 * 60 * 24 * 7, // 7 days
    })
  
    const systemContent = `設定其他條件 ${env.FRONTEND_HOST}\n取消通知訂閱 https://notify-bot.line.me/my/`
  
    if (matchedJobs.length > 10) {
      await sendLineNotify(
        `今日符合職缺共 ${matchedJobs.length} 筆，以上只顯示前 10 筆\n${viewUrl}\n\n${systemContent}`,
        notifyConfig.lineNotifyToken,
      )
    } else {
      await sendLineNotify(
        `今日符合職缺共 ${matchedJobs.length} 筆，以上為全部\n${viewUrl}\n\n${systemContent}`,
        notifyConfig.lineNotifyToken,
      )
    }
  }
}