import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { encryptSecret } from '../src/hosted/security.js'
import { EncryptedFileCredentialStore, EncryptedFileTokenStore } from '../src/hosted/token_store.js'

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

  it('ignores stored unsupported credential kinds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-token-store-'))
    const path = join(dir, 'credentials.json')
    await writeFile(path, JSON.stringify({
      version: 2,
      users: {
        'user-1': {
          userId: 'user-1',
          email: 'user@example.com',
          kind: 'unsupported_credential',
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
      },
    }))

    const store = new EncryptedFileCredentialStore(path, Buffer.alloc(32, 7))

    expect(await store.hasCredential('user-1')).toBe(true)
    expect(await store.getCredential('user-1')).toBeNull()
  })

  it('migrates legacy token-store files when read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-token-store-'))
    const path = join(dir, 'legacy.json')
    const key = Buffer.alloc(32, 5)
    await writeFile(path, JSON.stringify({
      version: 1,
      users: {
        'user-1': {
          userId: 'user-1',
          email: 'user@example.com',
          encryptedToken: encryptSecret('legacy-token', key),
          updatedAt: '2026-07-07T00:00:00.000Z',
        },
      },
    }))

    const store = new EncryptedFileCredentialStore(path, key)

    expect(await store.getCredential('user-1')).toEqual({
      kind: 'targetprocess_access_token',
      token: 'legacy-token',
    })
  })
})
