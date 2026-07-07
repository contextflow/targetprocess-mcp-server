import { createCipheriv, createDecipheriv, createHash, createHmac, createVerify, randomBytes, timingSafeEqual, type KeyObject } from "crypto"

export type JwtClaims = Record<string, unknown> & {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  iat?: number
}

export function randomBase64Url(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes))
}

export function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

export function base64UrlDecode(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  return Buffer.from(padded, "base64")
}

export function sha256Base64Url(value: string): string {
  return base64UrlEncode(createHash("sha256").update(value).digest())
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

export function parseBase64Key(value: string, expectedBytes: number, name: string): Buffer {
  const key = Buffer.from(value, "base64")
  if (key.length !== expectedBytes) {
    throw new Error(`${name} must decode to ${expectedBytes} bytes`)
  }
  return key
}

export function signJwt(claims: JwtClaims, key: Buffer, options: { issuer: string; expiresInSeconds: number }): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "HS256", typ: "JWT" }
  const payload = {
    ...claims,
    iss: options.issuer,
    iat: now,
    exp: now + options.expiresInSeconds,
  }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = createHmac("sha256", key).update(signingInput).digest()
  return `${signingInput}.${base64UrlEncode(signature)}`
}

export function verifyHmacJwt(token: string, key: Buffer, options: { issuer: string; audience?: string }): JwtClaims {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Malformed bearer token")
  }

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as { alg?: string }
  if (header.alg !== "HS256") {
    throw new Error("Unsupported bearer token algorithm")
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = base64UrlEncode(createHmac("sha256", key).update(signingInput).digest())
  if (!safeEqual(encodedSignature, expectedSignature)) {
    throw new Error("Invalid bearer token signature")
  }

  const claims = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as JwtClaims
  const now = Math.floor(Date.now() / 1000)
  if (claims.iss !== options.issuer) throw new Error("Invalid bearer token issuer")
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("Expired bearer token")
  if (options.audience && !audienceMatches(claims.aud, options.audience)) {
    throw new Error("Invalid bearer token audience")
  }
  return claims
}

export function verifyPkce(challenge: string, verifier: string): boolean {
  return safeEqual(challenge, sha256Base64Url(verifier))
}

export type EncryptedValue = {
  iv: string
  tag: string
  value: string
}

export function encryptSecret(plainText: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: base64UrlEncode(iv),
    tag: base64UrlEncode(tag),
    value: base64UrlEncode(encrypted),
  }
}

export function decryptSecret(encrypted: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, base64UrlDecode(encrypted.iv))
  decipher.setAuthTag(base64UrlDecode(encrypted.tag))
  return Buffer.concat([
    decipher.update(base64UrlDecode(encrypted.value)),
    decipher.final(),
  ]).toString("utf8")
}

export function decodeJwtClaims(token: string): JwtClaims {
  const [, encodedPayload] = token.split(".")
  if (!encodedPayload) throw new Error("Malformed JWT")
  return JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as JwtClaims
}

export function decodeJwtHeader(token: string): Record<string, unknown> {
  const [encodedHeader] = token.split(".")
  if (!encodedHeader) throw new Error("Malformed JWT")
  return JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as Record<string, unknown>
}

export function verifyAsymmetricJwtSignature(token: string, key: KeyObject, alg: string): void {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".")
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("Malformed JWT")
  if (alg !== "RS256") throw new Error(`Unsupported OIDC JWT algorithm: ${alg}`)

  const verifier = createVerify("RSA-SHA256")
  verifier.update(`${encodedHeader}.${encodedPayload}`)
  verifier.end()
  if (!verifier.verify(key, base64UrlDecode(encodedSignature))) {
    throw new Error("Invalid OIDC JWT signature")
  }
}

export function audienceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual === "string") return actual === expected
  if (Array.isArray(actual)) return actual.some((item) => item === expected)
  return false
}
