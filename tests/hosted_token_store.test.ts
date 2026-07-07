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

  it('stores encrypted Frontdoor API keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-token-store-'))
    const path = join(dir, 'credentials.json')
    const store = new EncryptedFileCredentialStore(path, Buffer.alloc(32, 7))

    await store.setCredential('user-1', 'user@example.com', {
      kind: 'frontdoor_api_key',
      keyAccess: 'frontdoor-access',
      keySecret: 'frontdoor-secret',
    })

    expect(await store.hasCredential('user-1')).toBe(true)
    expect(await store.getCredential('user-1')).toEqual({
      kind: 'frontdoor_api_key',
      keyAccess: 'frontdoor-access',
      keySecret: 'frontdoor-secret',
    })
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('frontdoor-access')
    expect(raw).not.toContain('frontdoor-secret')
    expect(JSON.parse(raw).version).toBe(2)
  })

  it('stores encrypted Frontdoor OpenTokens with renewal metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tp-mcp-token-store-'))
    const path = join(dir, 'credentials.json')
    const store = new EncryptedFileCredentialStore(path, Buffer.alloc(32, 8))

    await store.setCredential('tp:113', 'user@example.com', {
      kind: 'frontdoor_open_token',
      token: 'open-token',
      expiresAt: 1_800_000_000_000,
      renewAfter: 1_700_000_000_000,
      renewUntil: 1_900_000_000_000,
    })

    expect(await store.getCredential('tp:113')).toEqual({
      kind: 'frontdoor_open_token',
      token: 'open-token',
      expiresAt: 1_800_000_000_000,
      renewAfter: 1_700_000_000_000,
      renewUntil: 1_900_000_000_000,
    })
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('open-token')
    expect(JSON.parse(raw).users['tp:113'].kind).toBe('frontdoor_open_token')
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
