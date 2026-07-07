#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"

const baseUrl = trimTrailingSlash(process.env.MCP_PUBLIC_URL || "http://localhost:3000")
const clientId = process.env.MCP_LOCAL_CLIENT_ID || "local-claude-org"
const redirectUri = process.env.MCP_LOCAL_REDIRECT_URI || "http://localhost:3333/callback"
const toolName = process.argv[2] || "get_internal_card_types"
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {}

const token = await getAccessToken()
const sessionId = await initialize(token)
await notifyInitialized(token, sessionId)
const result = await callTool(token, sessionId, toolName, toolArgs)
console.log(JSON.stringify(result, null, 2))

async function getAccessToken() {
  const verifier = randomBase64Url(32)
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  const authorizeUrl = new URL("/oauth/authorize", baseUrl)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("client_id", clientId)
  authorizeUrl.searchParams.set("redirect_uri", redirectUri)
  authorizeUrl.searchParams.set("scope", "mcp:tools")
  authorizeUrl.searchParams.set("code_challenge", challenge)
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set("state", randomBase64Url(16))

  const callbackUrl = await followRedirects(authorizeUrl.toString(), 3)
  const code = new URL(callbackUrl).searchParams.get("code")
  if (!code) throw new Error(`OAuth callback did not include code: ${callbackUrl}`)

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`OAuth token exchange failed: HTTP ${response.status} ${await response.text()}`)
  const body = await response.json()
  if (!body.access_token) throw new Error("OAuth token response did not include access_token")
  return body.access_token
}

async function initialize(token) {
  const response = await mcpPost(token, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "local-mcp-call", version: "0.0.0" },
    },
  })
  if (!response.body.result) throw new Error(`MCP initialize failed: ${JSON.stringify(response.body)}`)
  if (!response.sessionId) throw new Error("MCP initialize did not return mcp-session-id")
  return response.sessionId
}

async function notifyInitialized(token, sessionId) {
  await mcpPost(token, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })
}

async function callTool(token, sessionId, name, args) {
  const response = await mcpPost(token, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  })
  return response.body
}

async function mcpPost(token, sessionId, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  if (sessionId) headers["Mcp-Session-Id"] = sessionId
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const parsed = parseMcpBody(text)
  if (!response.ok) throw new Error(`MCP request failed: HTTP ${response.status} ${text}`)
  return {
    sessionId: response.headers.get("mcp-session-id") || undefined,
    body: parsed,
  }
}

function parseMcpBody(text) {
  if (!text.trim()) return {}
  if (text.startsWith("event:") || text.startsWith("data:")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
    return data ? JSON.parse(data) : {}
  }
  return JSON.parse(text)
}

async function followRedirects(url, maxRedirects) {
  let current = url
  for (let index = 0; index < maxRedirects; index += 1) {
    const response = await fetch(current, { redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) throw new Error(`Redirect from ${current} did not include Location`)
      current = new URL(location, current).toString()
      continue
    }
    return current
  }
  return current
}

function randomBase64Url(bytes) {
  return base64Url(randomBytes(bytes))
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "")
}
