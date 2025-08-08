import { Bindings } from '../index'

export async function sendEmail(
  env: Bindings,
  to: string,
  subject: string,
  text: string,
  html: string,
) {
  const body = new URLSearchParams({
    from: env.SENDER_EMAIL,
    to,
    subject,
    text,
    html,
  })

  const res = await fetch(env.EMAIL_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa('api:' + env.EMAIL_API_KEY),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!res.ok) {
    throw new Error(await res.text())
  }

  return res
}
