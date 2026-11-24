import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { createRewindHostHandlers, FILE_PATH, PREPARE_PATH } from '../lib/rewind-host.js'

export const inject = ['connection', 'attachments', 'sessionQuery']

/** Mount authenticated rewind preparation and file-read routes on the Host. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const { handlePrepare, handleFile } = createRewindHostHandlers({
    sessionQuery: ctx.sessionQuery,
    attachments: ctx.attachments,
    queryActivity: sessionId => ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])),
    signal: lifetime.signal,
  })

  ctx.effect(() => {
    const offPrepare = ctx.connection.fetch.register({
      path: PREPARE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handlePrepare,
    })
    const offFile = ctx.connection.fetch.register({
      path: FILE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: handleFile,
    })
    return () => {
      lifetime.abort()
      offFile()
      offPrepare()
    }
  }, 'dsh-undo-unsent: host rewind routes')
}
