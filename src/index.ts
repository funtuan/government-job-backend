
import { Hono } from 'hono'
import { poweredBy } from 'hono/powered-by'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { getLineNotifyAccessToken } from "./utils/lineNotify"
import { 
  cronRefreshJobs, 
  cronNotify, 
  stringifyData,
  notifyConfigSchema,
  checkConditions,
} from './cronHandler'

export type Bindings = {
  kv: KVNamespace
  LINE_NOTIFY_CLIENT_ID: string
  LINE_NOTIFY_CLIENT_SECRET: string
  BACKEND_HOST: string
  FRONTEND_HOST: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', poweredBy())

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
        clientId: c.env.LINE_NOTIFY_CLIENT_ID,
        clientSecret: c.env.LINE_NOTIFY_CLIENT_SECRET,
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
