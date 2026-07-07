import { createHash } from "crypto"
import { buildTpFetchInit } from "../tp.js"
import type { TargetprocessCredential } from "./token_store.js"

export type FrontdoorOpenToken = {
  token: string
  expiresAt?: number
  renewAfter?: number
  renewUntil?: number
}

export class FrontdoorAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FrontdoorAuthError"
  }
}

export class FrontdoorClient {
  constructor(
    private readonly frontdoorUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async login(credential: Extract<TargetprocessCredential, { kind: "frontdoor_api_key" }>): Promise<FrontdoorOpenToken> {
    const url = new URL("/service/apikeylogin", this.frontdoorUrl).toString()
    const response = await this.fetchFn(url, buildTpFetchInit({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        keyAccess: credential.keyAccess,
        keySecret: credential.keySecret,
      }),
    }))

    if (!response.ok) {
      throw new FrontdoorAuthError(`Frontdoor API key login failed with HTTP ${response.status}`)
    }

    const token = response.headers.get("apptio-opentoken")
    if (!token) {
      throw new FrontdoorAuthError("Frontdoor API key login did not return apptio-opentoken")
    }

    return {
      token,
      ...tokenTimingFromHeaders(response.headers),
    }
  }

  async exchangeCode(code: string): Promise<FrontdoorOpenToken> {
    const url = new URL("/exchangeCode", this.frontdoorUrl).toString()
    const response = await this.fetchFn(url, buildTpFetchInit({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code }),
    }))

    if (!response.ok) {
      throw new FrontdoorAuthError(`Frontdoor code exchange failed with HTTP ${response.status}`)
    }

    const token = response.headers.get("apptio-opentoken")
    if (!token) {
      throw new FrontdoorAuthError("Frontdoor code exchange did not return apptio-opentoken")
    }

    return {
      token,
      ...tokenTimingFromHeaders(response.headers),
    }
  }

  async renewToken(token: string): Promise<FrontdoorOpenToken> {
    const url = new URL("/service/renewtoken", this.frontdoorUrl).toString()
    const response = await this.fetchFn(url, buildTpFetchInit({
      method: "GET",
      headers: {
        Accept: "application/json",
        "apptio-opentoken": token,
      },
    }))

    if (!response.ok) {
      throw new FrontdoorAuthError(`Frontdoor OpenToken renewal failed with HTTP ${response.status}`)
    }

    return {
      token: response.headers.get("apptio-opentoken") || token,
      ...tokenTimingFromHeaders(response.headers),
    }
  }
}

export class FrontdoorOpenTokenCache {
  private readonly cache = new Map<string, { fingerprint: string; token: string; expiresAt?: number }>()

  constructor(
    private readonly client: FrontdoorClient,
    private readonly expirySkewMs = 60_000,
  ) {}

  async getOpenToken(userId: string, credential: Extract<TargetprocessCredential, { kind: "frontdoor_api_key" }>): Promise<string> {
    const fingerprint = credentialFingerprint(credential)
    const cached = this.cache.get(userId)
    if (cached?.fingerprint === fingerprint && !this.isExpired(cached.expiresAt)) {
      return cached.token
    }

    const token = await this.client.login(credential)
    this.cache.set(userId, { fingerprint, token: token.token, expiresAt: token.expiresAt })
    return token.token
  }

  delete(userId: string): void {
    this.cache.delete(userId)
  }

  private isExpired(expiresAt?: number): boolean {
    return expiresAt !== undefined && expiresAt <= Date.now() + this.expirySkewMs
  }
}

function tokenTimingFromHeaders(headers: Headers): { expiresAt?: number; renewAfter?: number; renewUntil?: number } {
  return {
    ...optionalTimestamp(headers, "valid_till", "valid-till", "expiresAt"),
    ...optionalTimestamp(headers, "renew_after", "renew-after", "renewAfter"),
    ...optionalTimestamp(headers, "renew_till", "renew-till", "renewUntil"),
    ...optionalTimestamp(headers, "renew_until", "renew-until", "renewUntil"),
  }
}

function optionalTimestamp<T extends "expiresAt" | "renewAfter" | "renewUntil">(
  headers: Headers,
  snakeName: string,
  kebabName: string,
  key: T,
): Record<T, number> | {} {
  const parsed = parseValidTill(headers.get(snakeName) || headers.get(kebabName))
  return parsed === undefined ? {} : { [key]: parsed } as Record<T, number>
}

function parseValidTill(raw: string | null): number | undefined {
  if (!raw) return undefined
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

function credentialFingerprint(credential: Extract<TargetprocessCredential, { kind: "frontdoor_api_key" }>): string {
  return createHash("sha256")
    .update(credential.keyAccess)
    .update("\0")
    .update(credential.keySecret)
    .digest("hex")
}
