import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  parseBase64Key,
  sha256Base64Url,
  signJwt,
  verifyHmacJwt,
  verifyPkce,
} from '../src/hosted/security.js'

describe('hosted MCP security helpers', () => {
  it('signs and verifies audience-bound HMAC JWTs', () => {
    const key = Buffer.alloc(32, 7)
    const token = signJwt({
      sub: 'user-1',
      aud: 'https://mcp.example.com/mcp',
      email: 'user@example.com',
    }, key, {
      issuer: 'https://mcp.example.com',
      expiresInSeconds: 60,
    })

    const claims = verifyHmacJwt(token, key, {
      issuer: 'https://mcp.example.com',
      audience: 'https://mcp.example.com/mcp',
    })

    expect(claims.sub).toBe('user-1')
    expect(claims.email).toBe('user@example.com')
    expect(() => verifyHmacJwt(token, key, {
      issuer: 'https://mcp.example.com',
      audience: 'https://other.example.com/mcp',
    })).toThrow('audience')
  })

  it('verifies S256 PKCE challenges', () => {
    const verifier = 'very-secret-verifier'
    const challenge = sha256Base64Url(verifier)

    expect(verifyPkce(challenge, verifier)).toBe(true)
    expect(verifyPkce(challenge, 'wrong')).toBe(false)
  })

  it('encrypts and decrypts stored Targetprocess tokens', () => {
    const key = Buffer.alloc(32, 3)
    const encrypted = encryptSecret('tp-token', key)

    expect(encrypted.value).not.toContain('tp-token')
    expect(decryptSecret(encrypted, key)).toBe('tp-token')
    expect(() => decryptSecret(encrypted, Buffer.alloc(32, 4))).toThrow()
  })

  it('rejects incorrectly sized base64 keys', () => {
    expect(parseBase64Key(Buffer.alloc(32).toString('base64'), 32, 'KEY')).toHaveLength(32)
    expect(() => parseBase64Key(Buffer.alloc(16).toString('base64'), 32, 'KEY')).toThrow('32 bytes')
  })
})
