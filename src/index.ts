
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

export type Bindings = {
  kv: KVNamespace
  LINE_NOTIFY_ID: string
  LINE_NOTIFY_SECRET: string
  BACKEND_HOST: string
  FRONTEND_HOST: string
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

    await c.env.kv.put(`notifyConfig:${id}`, JSON.stringify({
      lineNotifyToken: accessToken,
      condition: data.condition,
    }))

    const conditionText = Object.entries({
      官等: data.condition.jobType || '不限',
      縣市: data.condition.citys.length > 0 ? data.condition.citys.join(', ') : '不限',
      職系: data.condition.sysnams.length > 0 ? data.condition.sysnams.join(', ') : '不限',
      是否排除身心障礙職缺: data.condition.isDisability != null ? (data.condition.isDisability ? '是' : '否') : '不限',
    }).map(([key, value]) => `${key}: ${value}`).join('\n')

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

export default {
  fetch: app.fetch,
  async scheduled(event, env: Bindings, ctx) {
    console.log('scheduled', event)
    // 區分事件
    if (event.cron === '30 9 * * *') {
      await cronRefreshJobs(env)
    }
    if (event.cron === '0 10 * * *') {
      await cronNotify(env)
    }
  },
}
