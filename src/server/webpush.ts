import { buildPushPayload } from '@block65/webcrypto-web-push'

// Permanent zero-setup fallback VAPID keypair (P-256)
// Can be overridden anytime via Cloudflare Worker environment variables:
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
export const DEFAULT_VAPID_PUBLIC_KEY = 'BJnY0CoLcsFvReeBAmBfdP9K-KIu4fROfOtcxsjEomm7yJnoIbLm-ukx7iHJabuwMUE2CcbptDsVV53BZ5YjYJQ'
export const DEFAULT_VAPID_PRIVATE_KEY = 'FpbM_gTPI8cDU_olIxHGpOnRk4MhrFSNu-GEUCo8Gw0'
export const DEFAULT_VAPID_SUBJECT = 'mailto:support@chatze.app'

export interface PushNotificationPayload {
  title: string
  body: string
  url?: string
  conversationId?: string
}

export interface StoredSubscription {
  id: string
  user_handle: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent?: string
  created_at: number
}

// In-memory fallback for subscriptions when running locally without D1
export const memoryPushSubscriptions = new Map<string, StoredSubscription>()

export function getVapidKeys(env?: any) {
  return {
    publicKey: env?.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY,
    privateKey: env?.VAPID_PRIVATE_KEY || DEFAULT_VAPID_PRIVATE_KEY,
    subject: env?.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
  }
}

/**
 * Dispatch background push notification to all active devices registered to a handle.
 * Designed with strict non-interference: runs asynchronously, never throws, and
 * auto-prunes expired (410/404) subscriptions.
 */
export async function sendPushNotification(
  env: any,
  targetHandle: string,
  notification: PushNotificationPayload
): Promise<void> {
  const cleanTarget = (targetHandle || '').replace(/^@/, '').trim().toLowerCase()
  if (!cleanTarget) return

  const vapid = getVapidKeys(env)
  const subscriptions: StoredSubscription[] = []

  // 1. Fetch from D1 if available
  const db = env?.DB
  if (db) {
    try {
      const { results } = await db
        .prepare('SELECT id, user_handle, endpoint, p256dh, auth, user_agent, created_at FROM push_subscriptions WHERE user_handle = ?')
        .bind(cleanTarget)
        .all()
      if (Array.isArray(results)) {
        subscriptions.push(...(results as StoredSubscription[]))
      }
    } catch (e: any) {
      console.warn('[Push Query D1 Warning]', e?.message)
    }
  }

  // 2. Fetch from in-memory fallback
  for (const sub of memoryPushSubscriptions.values()) {
    if (sub.user_handle === cleanTarget && !subscriptions.some((s) => s.endpoint === sub.endpoint)) {
      subscriptions.push(sub)
    }
  }

  if (subscriptions.length === 0) return

  // 3. Dispatch to all registered endpoints in parallel
  const payloadJson = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url || '/',
    conversationId: notification.conversationId,
  })

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        const payload = await buildPushPayload(
          { data: payloadJson },
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth,
            },
            expirationTime: null,
          },
          vapid
        )

        const res = await fetch(sub.endpoint, {
          method: payload.method,
          headers: payload.headers,
          body: payload.body as any,
        })

        // Auto-cleanup stale or expired tokens
        if (res.status === 410 || res.status === 404) {
          memoryPushSubscriptions.delete(sub.endpoint)
          if (db) {
            try {
              await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(sub.endpoint).run()
            } catch {}
          }
        }
      } catch (err: any) {
        console.warn(`[Push Delivery Failed for ${sub.endpoint.slice(0, 30)}...]`, err?.message)
      }
    })
  )
}
