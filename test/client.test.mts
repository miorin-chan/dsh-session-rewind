import assert from 'node:assert/strict'
import test from 'node:test'

let registration: { id: string; factory: (req: (id: string) => unknown) => { inject?: string[]; apply?: () => void } } | undefined

;(globalThis as { window?: unknown }).window = {
  __ModuleLoader__: {
    load: (entry: typeof registration) => { registration = entry },
  },
}
try {
  await import('../client.js')
} finally {
  delete (globalThis as { window?: unknown }).window
}

test('registers the clean @miorin/dsh-undo-unsent client entry', () => {
  assert.ok(registration)
  assert.equal(registration.id, '@miorin/dsh-undo-unsent')
  const plugin = registration.factory(() => ({}))
  assert.deepEqual(plugin.inject, [])
  assert.equal(typeof plugin.apply, 'function')
  plugin.apply?.()
})
