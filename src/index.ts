
import { Hono } from 'hono'
import { poweredBy } from 'hono/powered-by'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { cors } from 'hono/cors'
import { getLineNotifyAccessToken, sendLineNotify } from "./utils/lineNotify"
import { 
  cronRefreshJobs, 
  cronNotify, 
  stringifyData,
  notifyConfigSchema,
  checkConditions,
} from './cronHandler'
import { queueWorker } from './queueWorker'

export type Bindings = {
  kv: KVNamespace
  queue: Queue<any>
  LINE_NOTIFY_ID: string
  LINE_NOTIFY_SECRET: string
  BACKEND_HOST: string
  FRONTEND_HOST: string
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', poweredBy(), cors())

// 首頁 hello world
app.get('/', async(c) => {
  return c.html('hello world!')
})

// 取得符合條件新職缺
app.post(
  '/', 
  zValidator(
    'json',
    z.object({
      start: z.number(),
      limit: z.number().int().gte(1).lte(100).default(100),
      condition: notifyConfigSchema.shape.condition,
    }),
  ),
  async(c) => {
    const data = c.req.valid('json')
    const currentJobs = JSON.parse(await c.env.kv.get('currentJobs') || '[]')
  
    return c.json(
      currentJobs
        .filter((job) => checkConditions(job, data.condition))
        .slice(data.start, data.start + data.limit)
    )
  },
)
// curl -X POST -H "Content-Type: application/json" -d '{"start": 0, "limit": 10, "condition": {"sysnams": ["綜合行政", "文教行政"]}}' http://localhost:8787/

// 給予視圖清單
app.get('/view/:id', async(c) => {
  const newJobs = JSON.parse(await c.env.kv.get(`view:${c.req.param('id')}`) || '[]')

  return c.html(
    (
      (newJobs.length > 0 ? `符合 ${newJobs.length} 個職缺\n\n` : `無新增符合職缺\n\n`)
      + newJobs
        .map((job) => stringifyData(job.fields))
        // 連結改成可點擊
        .map((text) => text.replace(/連結: (.*)/g, '連結: <a href="$1">$1</a>'))
        .join('\n\n=======================\n\n')
    ).replace(/\n/g, '<br>'),
  )
})
// curl http://localhost:8787/view/1


// 註冊通知與 LINE Notify Token
app.post(
  '/notifyConfig',
  zValidator(
    'json',
    z.object({
      authorizationCode: z.string(),
      redirectUri: z.string(),
      condition: notifyConfigSchema.shape.condition,
    }),
  ),
  async(c) => {
    const data = c.req.valid('json')

    const id = Math.random().toString(36).slice(2)

    const accessToken = await getLineNotifyAccessToken(
      {
        clientId: c.env.LINE_NOTIFY_ID,
        clientSecret: c.env.LINE_NOTIFY_SECRET,
      },
      data.authorizationCode,
      data.redirectUri,
    )
    if (!accessToken) return c.json({
      error: 'get access token failed',
    }, 400)

    // 改成 DB insert
    await c.env.DB.prepare(`
      INSERT INTO notify_config (id, data)
      VALUES (?, ?)`).bind(id, JSON.stringify({
      lineNotifyToken: accessToken,
      condition: data.condition,
    })).run()
    /* await c.env.kv.put(`notifyConfig:${id}`, JSON.stringify({
      lineNotifyToken: accessToken,
      condition: data.condition,
    })) */

    const conditionText = Object.entries({
      官等: data.condition.jobType || '不限',
      縣市: data.condition.citys.length > 0 ? data.condition.citys.join('、') : '不限',
      職系: data.condition.sysnams.length > 0 ? data.condition.sysnams.join('、') : '不限',
      是否排除身心障礙職缺: data.condition.isDisability != null ? (data.condition.isDisability ? '否' : '是') : '不限',
    }).map(([key, value]) => `${key}：${value}`).join('\n')

    await sendLineNotify(
      `訂閱事求人職缺成功\n職缺過濾條件：\n${conditionText}\n\n將於每日下午 6 點通知符合條件新職缺`,
      accessToken,
    )

    return c.json({
      id,
    })
  },
)
// curl -X POST -H "Content-Type: application/json" -d '{"authorizationCode": "YOUR_AUTHORIZATION_CODE", "redirectUri": "YOUR_REDIRECT_URI", "condition": {"sysnams": ["綜合行政", "文教行政"]}}' http://localhost:8787/notifyConfig

// api call cronRefreshJobs
// curl "http://localhost:8787/__cronRefreshJobs"
app.get('/__cronRefreshJobs', async(c) => {
  await cronRefreshJobs(c.env)
  return c.json({
    message: 'success',
  })
})

// api call cronNotify
// curl "http://localhost:8787/__cronNotify"
app.get('/__cronNotify', async(c) => {
  await cronNotify(c.env)
  return c.json({
    message: 'success',
  })
})

app.post(
  '/__kvMigrate',
  zValidator(
    'json',
    z.object({
      index: z.number().int().gte(0),
    }),
  ),
  async(c) => {
    await kvMigrate(c.env, c.req.valid('json').index)
    return c.json({
      message: 'success',
    })
  },
)
/*
curl index 4~15 接續打
curl -X POST -H "Content-Type: application/json" -d '{"index": 4}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 5}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 6}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 7}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 8}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 9}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 10}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 11}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 12}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 13}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 14}' http://localhost:8787/__kvMigrate
curl -X POST -H "Content-Type: application/json" -d '{"index": 15}' http://localhost:8787/__kvMigrate

表示接續
*/

// 將 KV 數據遷移到 D1
const kvMigrate = async (env: Bindings, index: number) => {
  // 輪詢取得所有 keys
  const keys = []
  const res = (await env.kv.list({
    prefix: 'notifyConfig:',
  })) as any
  keys.push(...res.keys)
  let cursor = res.cursor
  do {
    const res = await env.kv.list({
      cursor,
    }) as any
    keys.push(...res.keys)
    cursor = res.cursor
  } while (cursor)

  // 依據 key name 排序
  keys.sort((a, b) => a.name.localeCompare(b.name))

  // 每次遷移 100 筆
  const start = index * 100
  const end = start + 100

  // 遷移 notifyConfig
  for (const key of keys.slice(start, end)) {
    const data = await env.kv.get(key.name)
    if (!data) continue
    const notifyConfig = JSON.parse(data)
    const id = key.name.replace('notifyConfig:', '')
    console.log('insert notifyConfig', id, notifyConfig)
    await env.DB.prepare(`
      INSERT INTO notify_config (id, data)
      VALUES (?, ?)`).bind(id, JSON.stringify(notifyConfig)).run()
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env: Bindings, ctx) {
    console.log('scheduled', event)
    // 只在台灣時間早上 9 點到晚上 9 點執行
    const now = new Date()
    const hour = now.getUTCHours() + 8
    if (hour < 9 || hour >= 21) return
    // 區分事件
    if (event.cron === '1 * * * *') {
      await cronRefreshJobs(env)
    }
    // curl "http://192.168.8.153:8787/__scheduled?cron=0+10+*+*+*"
    if (event.cron === '11 * * * *') {
      await cronNotify(env)
    }
  },
  queue: queueWorker,
}
