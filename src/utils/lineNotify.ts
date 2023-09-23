
// send line notify
export async function sendLineNotify(message, token) {
  const res = await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams({
      message: '\n' + message,
    }),
  })

  return res
}

// get line notify access token
export async function getLineNotifyAccessToken(
  {
    clientId, 
    clientSecret,
  },
  code,
  redirectUri,
) {
  const res = await fetch('https://notify-bot.line.me/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }) as any

  return (await res.json())?.access_token
}