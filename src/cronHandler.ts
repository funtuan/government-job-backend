
import { Bindings } from "./index"
import { z } from 'zod'

export const notifyConfigSchema = z.object({
  id: z.string(),
  lineNotifyToken: z.string(),
  condition: z.object({
    jobType: z.string().optional(),
    citys: z.array(z.string()).optional(),
    isDisability: z.boolean().optional(),
    sysnams: z.array(z.string()).optional(),
  }),
})

export type NotifyConfig = z.infer<typeof notifyConfigSchema>
export type NotifyCondition = z.infer<typeof notifyConfigSchema>['condition']

// 取得當前職缺
async function getJob() {
  const res = await fetch(
    'http://opencpa.castman.net/'
  )

  const html = await res.text()

  // 取得 var jobdata = [ ... ] 內的資料
  const jobdata = html.match(/var jobdata = \[.*\]/)[0]
  const jobs = JSON.parse(jobdata.replace('var jobdata = ', ''))

  return jobs
}

// 職缺條件轉換
function convertJobCondition(fields: any) {
  // 是否須具身心障礙手冊
  let isDisability = false
  if (
    (
      fields?.work_quality?.includes('具身心障礙證明') &&
      !fields?.work_quality.match(/具身心障礙證明.{0,10}優先/)
    ) ||
    fields?.title?.includes('具身心障礙證明')
  ) {
    isDisability = true
  }

  // 縣市，須由地址轉換（市、縣）文字切分
  const match = fields?.work_addr?.match(/(.+[市縣]).+/)
  const city = match && match.length > 1 ? match[1].replace('台', '臺') : '未知'

  return {
    workId: fields?.view_url.match(/work_id=(\d+)/)[1],
    city,
    isDisability,
  }
}

// 檢查職缺是否符合條件
export function checkConditions(data: any, condition: NotifyCondition) {
  if (
    condition.jobType != null &&
    !data?.fields?.job_type.includes(condition.jobType)
  ) {
    return false
  }
  if (
    condition.citys != null &&
    !condition.citys.includes(data?.city)
  ) {
    return false
  }
  if (
    condition.isDisability != null &&
    data?.isDisability !== condition.isDisability
  ) {
    return false
  }
  if (
    condition.sysnams != null &&
    !condition.sysnams.find((sysnam: string) => data?.fields?.sysnam?.includes(sysnam))
  ) {
    return false
  }
  return true
}

// 以 API 取得職缺資料存入 KV
export const cronRefreshJobs = async (env: Bindings) => {
  const jobs = await getJob()

  const currentJobs = jobs.map((job) => ({
    ...job,
    ...(job.fields ? convertJobCondition(job.fields): {}),
  }))
  console.log(`currentJobs: ${currentJobs.length}`)

  await env.kv.put('currentJobs', JSON.stringify(currentJobs))
}

// 資料文字化
export const stringifyData = (data) => {
  const textJson = {
    '單位': data.org_name,
    '地點': data.work_addr,
    '職稱職等': `${data.sysnam} ${data.title} - ${data.job_type} (${data.rank_from}~${data.rank_to})`,
    '工作內容': data.work_item,
    '時間': `${data.date_from} ~ ${data.date_to}`,
    '連結': data.view_url,
  }

  return Object.entries(textJson).map(([key, value]) => `${key}: ${value}`).join('\n')
}

// Notify 提醒
export const cronNotify = async (env: Bindings) => {
  // DB 查詢所有 notifyConfig 設定
  const { results: notifyConfigs } = await env.DB.prepare(`SELECT * FROM notify_config`).all() as { results: any[]}
  console.log(`notifyConfigs: ${notifyConfigs.length}`)

  // 取得 KV 中的 currentJobs
  const currentJobs = JSON.parse(await env.kv.get('currentJobs') || '[]')

  // 取得已經提醒過的 workId: reminderNotifyWorkIds
  const reminderNotifyWorkIds = JSON.parse(await env.kv.get('reminderNotifyWorkIds') || '[]')

  const newJobs = currentJobs.filter((job: any) => !reminderNotifyWorkIds.includes(job.workId))

  // 正確格式 notifyConfigs
  const notifyNotifyConfigs = notifyConfigs.filter((one) => one.data && one.data.includes('lineNotifyToken'))
  console.log('notifyConfigs.length', notifyConfigs.length)
  console.log('notifyNotifyConfigs.length', notifyNotifyConfigs.length)
  if (newJobs.length > 0) {
    for (const one of notifyNotifyConfigs) {
      try {
        const notifyConfig: NotifyConfig = JSON.parse(one.data)
  
        const matchedJobs = newJobs.filter((job: any) => checkConditions(job, notifyConfig.condition))
  
        if (matchedJobs.length === 0) continue

        // Add queue
        console.log('env.queue.send', {
          id: one.id,
          matchedJobs,
          notifyConfig,
        })
        await env.queue.send({
          id: one.id,
          matchedJobs,
          notifyConfig,
        })
      } catch (error) {
        console.log('notifyConfig error', one, error)
        continue
      }
    }
  }

  // 更新已經提醒過的 workId
  await env.kv.put('reminderNotifyWorkIds', JSON.stringify(
    Array.from(new Set(
      [
        ...newJobs.map((job: any) => job.workId),
        ...reminderNotifyWorkIds,
      ]
    )).slice(0, 50000),
  ))
}

