import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { EncryptedFileTokenStore } from '../src/hosted/token_store.js'

describe('encrypted hosted Targetprocess token store', () => {
  it('stores encrypted per-user tokens and supports revocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-token-store-'))
    const path = join(dir, 'tokens.json')
    const store = new EncryptedFileTokenStore(path, Buffer.alloc(32, 9))

    await store.setToken('user-1', 'user@example.com', 'tp-token')

    expect(await store.hasToken('user-1')).toBe(true)
    expect(await store.getToken('user-1')).toBe('tp-token')
    expect(await readFile(path, 'utf8')).not.toContain('tp-token')

    await store.deleteToken('user-1')
    expect(await store.hasToken('user-1')).toBe(false)
    expect(await store.getToken('user-1')).toBeNull()
  })
})
