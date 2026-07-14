import { TpClientParameters, TpResponse, TpResult, Relation, BugInputSchema, Bug, Task, LoggedUser, CreateTaskInputSchema, CardStatus, TpResponseV2, CustomFieldInput, TpEntityCollection, TpNativeCardType } from "./types.js";
import { config } from "./config.js";
import { ProxyAgent, type Dispatcher } from "undici";

type TpFetchInit = RequestInit

export type TpRequestDiagnostic = {
  method: string
  url: string
  message: string
  status?: number
  body?: string
}

export type TargetprocessAuth =
  | { kind: "accessToken"; token: string }
  | { kind: "apptioOpenToken"; token: string }

export type TpClientOptions = {
  baseUrl?: string
  auth?: TargetprocessAuth
  token?: string
  ownerId?: string
  projectId?: string
  teamId?: string
  processId?: string
  userStoryWorkflowId?: string
  bugWorkflowId?: string
  proxySocket?: string
}

function tpString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function tpNativeTypeCollection(nativeType: TpNativeCardType): TpEntityCollection {
  switch (nativeType) {
    case "General": return "Generals"
    case "UserStory": return "UserStories"
    case "Bug": return "Bugs"
    case "Feature": return "Features"
    case "Epic": return "Epics"
    case "Request": return "Requests"
  }
}

function normalizedBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== "https:") {
    throw new Error("TP_BASE_URL must use https://")
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("TP_BASE_URL must use the default HTTPS port 443")
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "")
  parsed.search = ""
  parsed.hash = ""
  return parsed
}

function appendPath(url: URL, segments: string[], trailingSlash: boolean): URL {
  const basePath = url.pathname.replace(/\/$/, "")
  const encodedSegments = segments
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
  url.pathname = [basePath, ...encodedSegments].filter(Boolean).join("/") + (trailingSlash ? "/" : "")
  return url
}

export function assertTargetprocessUrlAllowed(baseUrl: string, url: URL): void {
  const base = normalizedBaseUrl(baseUrl)
  if (url.protocol !== "https:" || url.origin !== base.origin) {
    throw new Error(`Refusing outbound request to non-Targetprocess origin: ${url.origin}`)
  }
}

export function buildTargetprocessUrl(
  baseUrl: string,
  pathSegments: string[],
  query: Record<string, string | number>,
  options: { trailingSlash?: boolean } = {},
): string {
  const url = appendPath(normalizedBaseUrl(baseUrl), pathSegments, options.trailingSlash ?? true)
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value))
  }
  assertTargetprocessUrlAllowed(baseUrl, url)
  return url.toString()
}

export function buildTpUrl(baseUrl: string, params: TpClientParameters): string {
  const apiVersionSegments = (params.apiVersion || "/api/v1")
    .split("/")
    .filter(Boolean)
  return buildTargetprocessUrl(baseUrl, [...apiVersionSegments, ...params.pathParam], params.param)
}

export function createTpDispatcher(proxySocket: string): Dispatcher | undefined {
  if (!proxySocket) return undefined

  return new ProxyAgent({
    uri: "http://targetprocess-mcp-proxy",
    proxyTls: {
      socketPath: proxySocket,
    },
  })
}

export function buildTpFetchInit(init: TpFetchInit, dispatcher?: Dispatcher): TpFetchInit {
  return {
    ...init,
    redirect: "error",
    ...(dispatcher ? { dispatcher } : {}),
  }
}

export class TpClient {

  private baseUrl: string
  private auth: TargetprocessAuth
  private ownerIdConfig: string
  private projectId: string
  private teamId: string
  private processId: string
  private headers: Record<string, string>
  private dispatcher: Dispatcher | undefined
  private loggedInOwnerId: string | undefined
  private lastRequestDiagnostic: TpRequestDiagnostic | undefined
  private lastRequestWarning: string | undefined
  private readonly v2 = '/api/v2'
  private readonly debugHttp = process.env.TP_DEBUG_HTTP === "1"

  constructor(options: TpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? config.tp.url
    this.auth = options.auth ?? { kind: "accessToken", token: options.token ?? config.tp.token }
    this.ownerIdConfig = options.ownerId ?? config.tp.ownerId
    this.projectId = options.projectId ?? config.tp.projectId
    this.teamId = options.teamId ?? config.tp.teamId
    this.processId = options.processId ?? config.tp.processId
    this.dispatcher = createTpDispatcher(options.proxySocket ?? config.tp.proxySocket)
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    }
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private params(params: TpClientParameters): string {
    return buildTpUrl(this.baseUrl, params)
  }

  private authToken(): string {
    return this.auth.token
  }

  private withAuthParams(params: TpClientParameters): TpClientParameters {
    if (this.auth.kind !== "accessToken") return { ...params, param: { ...params.param } }
    return {
      ...params,
      param: {
        ...params.param,
        access_token: this.auth.token,
      },
    }
  }

  private withAuthHeaders(headers: Record<string, string> = this.headers): Record<string, string> {
    if (this.auth.kind !== "apptioOpenToken") return headers
    return {
      ...headers,
      "apptio-opentoken": this.auth.token,
    }
  }

  private missingAuthMessage(): string {
    return this.auth.kind === "accessToken" ? "TP_TOKEN is required" : "Targetprocess OpenToken is required"
  }

  private redactUrl(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.searchParams.has("access_token")) {
        parsed.searchParams.set("access_token", "***")
      }
      return parsed.toString()
    } catch {
      const redacted = url.replace(/access_token=[^&\s]*/g, "access_token=***")
      const token = this.authToken()
      return token ? redacted.replaceAll(token, "***") : redacted
    }
  }

  private debug(label: string, value: unknown): void {
    if (this.debugHttp) {
      console.error(JSON.stringify({ [label]: value }))
    }
  }

  protected async fetch(url: string, init: TpFetchInit) {
    return fetch(url, buildTpFetchInit(init, this.dispatcher))
  }

  getLastRequestDiagnostic(): TpRequestDiagnostic | undefined {
    return this.lastRequestDiagnostic
  }

  getLastRequestWarning(): string | undefined {
    return this.lastRequestWarning
  }

  clearLastRequestDiagnostic(): void {
    this.lastRequestDiagnostic = undefined
    this.lastRequestWarning = undefined
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private truncate(text: string, maxLength = 1000): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
  }

  private redactText(text: string): string {
    const withoutQueryToken = text.replace(/access_token=[^&\s"]*/g, "access_token=***")
    const token = this.authToken()
    return token ? withoutQueryToken.replaceAll(token, "***") : withoutQueryToken
  }

  private recordRequestDiagnostic({
    method,
    url,
    message,
    status,
    body,
  }: {
    method: string
    url: string
    message: string
    status?: number
    body?: string
  }): void {
    this.lastRequestDiagnostic = {
      method,
      url: this.redactUrl(url),
      message: this.redactText(message),
      ...(status !== undefined ? { status } : {}),
      ...(body ? { body: this.truncate(this.redactText(body)) } : {}),
    }
  }

  private async ownerId(): Promise<string | null> {
    if (this.ownerIdConfig) return this.ownerIdConfig
    if (this.loggedInOwnerId) return this.loggedInOwnerId

    const context = await this.getContext<{ LoggedUser?: { Id?: string | number } }>()
    const id = context?.LoggedUser?.Id
    if (id === undefined || id === null || id === "") {
      console.error("Unable to resolve Targetprocess logged-in user ID")
      return null
    }

    this.loggedInOwnerId = String(id)
    return this.loggedInOwnerId
  }

  // @ts-ignore
  private async getAll<T>(params: TpClientParameters): Promise<T[]> {
    const allItems: T[] = []
    let skip = 0
    const take = 100

    while (true) {
      params.param["take"] = take
      params.param["skip"] = skip
      const page = await this.get<TpResponse<T>>(params)
      if (!page?.Items?.length) break
      allItems.push(...page.Items)
      if (!page.Next) break
      skip += take
    }

    return allItems
  }

  private async get<T>(params: TpClientParameters): Promise<T | null> {
    let _url = this.params(this.withAuthParams(params))
    this.clearLastRequestDiagnostic()
    if (!this.authToken()) {
      const message = this.missingAuthMessage()
      this.recordRequestDiagnostic({
        method: "GET",
        url: _url,
        message,
      })
      console.error("Error making TP request:", message);
      console.error("Request URL:", this.redactUrl(_url));
      return null
    }

    try {
      const response = await this.fetch(_url, {
        method: "GET",
        headers: this.withAuthHeaders(),
      });
      const text = await response.text()
      if (!response.ok) {
        this.recordRequestDiagnostic({
          method: "GET",
          url: _url,
          message: `HTTP error! status: ${response.status}`,
          status: response.status,
          body: text,
        })
        const diagnostic = this.getLastRequestDiagnostic()
        console.error("Error making TP request:", diagnostic?.message);
        console.error("Request URL:", diagnostic?.url);
        return null
      }

      try {
        return (text ? JSON.parse(text) : null) as T
      } catch (error) {
        this.recordRequestDiagnostic({
          method: "GET",
          url: _url,
          message: `Failed to parse Targetprocess JSON response: ${this.errorMessage(error)}`,
          status: response.status,
          body: text,
        })
        const diagnostic = this.getLastRequestDiagnostic()
        console.error("Error parsing TP response:", error);
        console.error("Request URL:", diagnostic?.url);
        return null
      }
    } catch (error) {
      this.recordRequestDiagnostic({
        method: "GET",
        url: _url,
        message: this.errorMessage(error),
      })
      console.error("Error making TP request:", error);
      console.error("Request URL:", this.redactUrl(_url));
      return null;
    }
  }

  private async post<T, U>(params: TpClientParameters, data: T): Promise<U | null> {
    let _url = this.params(this.withAuthParams(params))
    this.clearLastRequestDiagnostic()
    this.debug("TP_POST_URL", this.redactUrl(_url))
    this.debug("TP_POST_BODY", data)
    if (!this.authToken()) {
      const message = this.missingAuthMessage()
      this.recordRequestDiagnostic({
        method: "POST",
        url: _url,
        message,
      })
      console.error("Error making TP request:", message);
      console.error("Request URL:", this.redactUrl(_url));
      return null
    }

    try {
      const response = await this.fetch(_url, {
        method: "POST",
        headers: this.withAuthHeaders(),
        body: JSON.stringify(data),
      });
      const text = await response.text()
      this.debug("TP_POST_RESPONSE", {
        status: response.status,
        ok: response.ok,
        body: text ? this.truncate(this.redactText(text)) : "<empty>",
      })
      if (!response.ok) {
        this.recordRequestDiagnostic({
          method: "POST",
          url: _url,
          message: `HTTP error! status: ${response.status}`,
          status: response.status,
          body: text || "<empty>",
        })
        const diagnostic = this.getLastRequestDiagnostic()
        console.error("Error making TP request:", diagnostic?.message);
        console.error("Request URL:", diagnostic?.url);
        return null
      }

      if (!text) {
        this.recordRequestDiagnostic({
          method: "POST",
          url: _url,
          message: "Targetprocess returned an empty response body",
          status: response.status,
          body: "<empty>",
        })
        return null
      }

      try {
        const parsed = JSON.parse(text)
        if (parsed === null) {
          this.recordRequestDiagnostic({
            method: "POST",
            url: _url,
            message: "Targetprocess returned JSON null",
            status: response.status,
            body: text,
          })
          return null
        }
        return parsed as U
      } catch (error) {
        this.recordRequestDiagnostic({
          method: "POST",
          url: _url,
          message: `Failed to parse Targetprocess JSON response: ${this.errorMessage(error)}`,
          status: response.status,
          body: text,
        })
        const diagnostic = this.getLastRequestDiagnostic()
        console.error("Error parsing TP response:", error);
        console.error("Request URL:", diagnostic?.url);
        return null
      }
    } catch (error) {
      this.recordRequestDiagnostic({
        method: "POST",
        url: _url,
        message: this.errorMessage(error),
      })
      console.error("Error making TP request:", error);
      return null;
    }
  }

  private async postBugWithOriginFallback<T>(bug: Record<string, any>): Promise<T | null> {
    const params = {
      pathParam: ["bugs"],
      param: { "format": "json" },
    }
    const response = await this.post<Record<string, any>, T>(params, bug)
    const diagnostic = this.getLastRequestDiagnostic()
    const origin = bug.customFields?.find((field: { name?: string }) => field.name === "Origin")?.value
    const originFieldMissing = diagnostic?.status === 400
      && diagnostic.body?.includes("There's no Origin custom field in this Project.")

    if (response || !origin || !originFieldMissing) return response

    const fallbackBug = { ...bug }
    delete fallbackBug.customFields
    const fallbackResponse = await this.post<Record<string, any>, T>(params, fallbackBug)
    if (fallbackResponse) {
      this.lastRequestWarning = `Origin "${origin}" was not applied because the target project does not define the Origin custom field.`
    }
    return fallbackResponse
  }

  // Like post(), but on failure returns the HTTP status and raw response body
  // instead of null, so callers can surface TP's error detail to the user.
  private async postRaw<T, U>(params: TpClientParameters, data: T): Promise<TpResult<U>> {
    let _url = this.params(this.withAuthParams(params))
    this.clearLastRequestDiagnostic()
    this.debug("TP_POST_URL", this.redactUrl(_url))
    this.debug("TP_POST_BODY", data)
    if (!this.authToken()) {
      const message = this.missingAuthMessage()
      this.recordRequestDiagnostic({
        method: "POST",
        url: _url,
        message,
        body: JSON.stringify(data),
      })
      return { ok: false, status: 0, body: message }
    }
    try {
      const response = await this.fetch(_url, {
        method: "POST",
        headers: this.withAuthHeaders(),
        body: JSON.stringify(data),
      });
      const text = await response.text()
      if (!response.ok) {
        this.recordRequestDiagnostic({
          method: "POST",
          url: _url,
          message: `HTTP error! status: ${response.status}`,
          status: response.status,
          body: JSON.stringify(data),
        })
        this.debug("TP_POST_ERROR", { status: response.status, body: text })
        return { ok: false, status: response.status, body: text }
      }
      return { ok: true, data: (text ? JSON.parse(text) : null) as U }
    } catch (error) {
      this.recordRequestDiagnostic({
        method: "POST",
        url: _url,
        message: this.errorMessage(error),
        body: JSON.stringify(data),
      })
      console.error("Error making TP request:", error);
      return { ok: false, status: 0, body: String(error) }
    }
  }

  // DELETE request that, like postRaw(), surfaces the HTTP status and raw
  // response body on failure so callers can report TP's error detail.
  private async del<U>(params: TpClientParameters): Promise<TpResult<U>> {
    let _url = this.params(this.withAuthParams(params))
    this.clearLastRequestDiagnostic()
    this.debug("TP_DELETE_URL", this.redactUrl(_url))
    if (!this.authToken()) {
      const message = this.missingAuthMessage()
      this.recordRequestDiagnostic({
        method: "DELETE",
        url: _url,
        message,
      })
      return { ok: false, status: 0, body: message }
    }
    try {
      const response = await this.fetch(_url, {
        method: "DELETE",
        headers: this.withAuthHeaders(),
      });
      const text = await response.text()
      if (!response.ok) {
        this.recordRequestDiagnostic({
          method: "DELETE",
          url: _url,
          message: `HTTP error! status: ${response.status}`,
          status: response.status,
        })
        this.debug("TP_DELETE_ERROR", { status: response.status, body: text })
        return { ok: false, status: response.status, body: text }
      }
      return { ok: true, data: (text ? JSON.parse(text) : null) as U }
    } catch (error) {
      this.recordRequestDiagnostic({
        method: "DELETE",
        url: _url,
        message: this.errorMessage(error),
      })
      console.error("Error making TP request:", error);
      return { ok: false, status: 0, body: String(error) }
    }
  }

  async getUserStory<T>(userStoryId: string): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["userStories", userStoryId],
      param: { "format": "json" },
    }) as T

    return response
  }

  async getBug<T>(bugId: string): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["bugs", bugId],
      param: { "format": "json" }
    }) as T

    return response
  }

  async getFeature<T>(featureId: string): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["features", featureId],
      param: { "format": "json" }
    }) as T

    return response
  }

  async getRequest<T>(requestId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["Requests", requestId],
      param: { "format": "json" },
    }) as T
  }

  async getInternalCard<T>(nativeType: TpNativeCardType, cardId: string): Promise<T> {
    return this.get<T>({
      pathParam: [tpNativeTypeCollection(nativeType), cardId],
      param: { "format": "json" },
    }) as T
  }

  async getGeneral<T>(cardId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["Generals", cardId],
      param: {
        "format": "json",
        "include": "[Id,Name,ResourceType,EntityType[Name]]",
      },
    }) as T
  }

  async createBug<T>({ title, card, bugContent, origin = "Manual QA", projectId, teamId }: { title: string, card: { id: string, type: "UserStory" | "Bug" | "Feature" }, bugContent: string, origin?: string, projectId?: string, teamId?: string }): Promise<T> {
    const bug = {
      "Name": title,
      "Project": {
        "Id": projectId || this.projectId
      },
      "customFields": [{
        "name": "Origin",
        "type": "DropDown",
        "value": origin
      }],
      "assignedTeams": [{
        "team": {
          "id": teamId || this.teamId
        }
      }],
      "Description": bugContent,
    } as any

    if (card.type === "UserStory") {
      bug["UserStory"] = { "Id": card.id }
    } else if (card.type === "Feature") {
      bug["Feature"] = { "Id": card.id }
    }

    return this.post<any, T>({
      pathParam: ["bugs"],
      param: { "format": "json" },
    }, bug) as T
  }

  async updateUserStorySubState<T>({
    id,
    teamId,
    teamAssignmentId,
    entityStateId
  }: { id: string, teamId?: string, teamAssignmentId?: string, entityStateId?: string }): Promise<T> {
    const userStory: Record<string, any> = { "id": id }

    if (entityStateId) userStory["assignedTeams"] = [{
      "id": teamAssignmentId,
      "team": {
        "id": teamId
      },
      "entityState": {
        "id": entityStateId
      }
    }]

    return this.post<any, T>({
      pathParam: ["UserStories", id],
      param: { "format": "json" },
    }, userStory) as T
  }

  async updateUserStory<T>({
    id,
    title,
    description,
    projectId,
    teamId,
    entityStateId
  }: { id: string, title?: string, description?: string, projectId?: string, teamId?: string, teamAssignmentId?: string, entityStateId?: string }): Promise<T> {
    const userStory: Record<string, any> = { "Id": id }

    if (title) userStory["Name"] = title
    if (description) userStory["Description"] = description
    if (projectId) userStory["Project"] = { "Id": projectId }
    if (teamId) userStory["assignedTeams"] = [{ "team": { "id": teamId } }]
    if (entityStateId) userStory["EntityState"] = { "Id": entityStateId }

    return this.post<any, T>({
      pathParam: ["UserStories"],
      param: { "format": "json" },
    }, userStory) as T
  }

  async updateBug<T>({ id, title, bugContent, origin, projectId, teamId, entityStateId }: { id: string, title?: string, bugContent?: string, origin?: string, projectId?: string, teamId?: string, entityStateId?: string }): Promise<T> {
    const bug: Record<string, any> = { "Id": id }

    if (title) bug["Name"] = title
    if (bugContent) bug["Description"] = bugContent
    if (origin) bug["customFields"] = [{
      "name": "Origin",
      "type": "DropDown",
      "value": origin
    }]
    if (projectId) bug["Project"] = { "Id": projectId }
    if (teamId) bug["assignedTeams"] = [{
      "team": {
        "id": teamId || this.teamId
      }
    }]
    if (entityStateId) bug["entityState"] = { "id": entityStateId }

    return this.post<any, T>({
      pathParam: ["bugs"],
      param: { "format": "json" },
    }, bug) as T
  }

  async createBugOnly<T>({ title, bugContent, origin = "Manual QA", projectId, teamId, entityStateId }: BugInputSchema): Promise<T> {
    const bug: Record<string, any> = {
      "Name": title,
      "Project": {
        "Id": projectId || this.projectId
      },
      "customFields": [{
        "name": "Origin",
        "type": "DropDown",
        "value": origin
      }],
      "assignedTeams": [{
        "team": {
          "id": teamId || this.teamId
        }
      }],
      "Description": bugContent,
    }

    if (entityStateId) bug["EntityState"] = { "Id": entityStateId }

    return this.postBugWithOriginFallback<T>(bug) as T
  }

  async createUserStory<T>({ title, description, featureId, releaseId, projectId, teamId }: { title: string, description?: string, featureId?: string, releaseId?: string, projectId?: string, teamId?: string }): Promise<T> {
    const resolvedProjectId = nonEmpty(projectId) || nonEmpty(this.projectId)
    const resolvedTeamId = nonEmpty(teamId) || nonEmpty(this.teamId)
    const userStory: Record<string, any> = {
      "Name": title,
    }

    if (resolvedProjectId) userStory["Project"] = { "Id": resolvedProjectId }
    if (resolvedTeamId) userStory["assignedTeams"] = [{ "team": { "id": resolvedTeamId } }]
    if (description) userStory["Description"] = description
    if (featureId) userStory["Feature"] = { "Id": featureId }
    if (releaseId) userStory["Release"] = { "Id": releaseId }

    return this.post<any, T>({
      pathParam: ["UserStories"],
      param: { "format": "json" },
    }, userStory) as T
  }


  async getEpic<T>(epicId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["Epics", epicId],
      param: { "format": "json" },
    }) as T
  }

  async updateEpic<T>({ id, title, description, releaseId, projectId }: { id: string, title?: string, description?: string, releaseId?: string, projectId?: string }): Promise<T> {
    const epic: Record<string, any> = { "Id": id }
    if (title) epic["Name"] = title
    if (description) epic["Description"] = description
    if (projectId) epic["Project"] = { "Id": projectId }
    if (releaseId) epic["Release"] = { "Id": releaseId }

    return this.post<any, T>({
      pathParam: ["Epics"],
      param: { "format": "json" },
    }, epic) as T
  }

  async getEpicFeatures<T>(epicId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["Features"],
      param: {
        "format": "json",
        "where": `Epic.Id eq ${epicId}`,
        "include": "[Id,Name,Description,EntityState[Name],Team[Name],Release[Name],Progress,Effort]",
        "take": 100,
      },
    }) as T
  }

  async createEpic<T>({
    title,
    description,
    releaseId,
    projectId,
    teamId,
    customFields,
  }: {
    title: string
    description?: string
    releaseId?: string
    projectId?: string
    teamId?: string
    customFields?: CustomFieldInput[]
  }): Promise<T | null> {
    const resolvedProjectId = nonEmpty(projectId) || nonEmpty(this.projectId)
    const resolvedTeamId = nonEmpty(teamId)
    const epic: Record<string, any> = {
      "Name": title,
    }

    if (resolvedProjectId) epic["Project"] = { "Id": resolvedProjectId }
    if (description) epic["Description"] = description
    if (releaseId) epic["Release"] = { "Id": releaseId }
    if (resolvedTeamId) epic["assignedTeams"] = [{ "team": { "id": resolvedTeamId } }]
    if (customFields && customFields.length > 0) epic["customFields"] = customFields

    return this.post<any, T>({
      pathParam: ["Epics"],
      param: { "format": "json" },
    }, epic)
  }

  async createFeature<T>({ title, description, epicId, releaseId, projectId, teamId }: { title: string, description?: string, epicId?: string, releaseId?: string, projectId?: string, teamId?: string }): Promise<T> {
    const feature: Record<string, any> = {
      "Name": title,
      "Project": { "Id": projectId || this.projectId },
      "assignedTeams": [{ "team": { "id": teamId || this.teamId } }],
    }

    if (description) feature["Description"] = description
    if (epicId) feature["Epic"] = { "Id": epicId }
    if (releaseId) feature["Release"] = { "Id": releaseId }

    return this.post<any, T>({
      pathParam: ["Features"],
      param: { "format": "json" },
    }, feature) as T
  }

  async createRequest<T>({
    title,
    description,
    releaseId,
    projectId,
    teamId,
    entityStateId,
    customFields,
  }: {
    title: string
    description?: string
    releaseId?: string
    projectId?: string
    teamId?: string
    entityStateId?: string
    customFields?: CustomFieldInput[]
  }): Promise<T> {
    const request: Record<string, any> = {
      "Name": title,
      "Project": { "Id": projectId || this.projectId },
    }

    if (description) request["Description"] = description
    if (releaseId) request["Release"] = { "Id": releaseId }
    if (teamId) request["assignedTeams"] = [{ "team": { "id": teamId } }]
    if (entityStateId) request["EntityState"] = { "Id": entityStateId }
    if (customFields && customFields.length > 0) request["customFields"] = customFields

    return this.post<any, T>({
      pathParam: ["Requests"],
      param: { "format": "json" },
    }, request) as T
  }

  async createBugBasedOnUserStory<T>(title: string, userStoryId: string, bugContent: string): Promise<T> {
    const bug = {
      "Name": title,
      "Project": {
        "Id": this.projectId
      },
      "UserStory": {
        "Id": userStoryId
      },
      "customFields": [{
        "name": "Origin",
        "type": "DropDown",
        "value": "Manual QA"
      }],
      "assignedTeams": [{
        "team": {
          "id": this.teamId
        }
      }],
      "Description": bugContent,
    }

    return this.post<any, T>({
      pathParam: ["bugs"],
      param: { "format": "json" },
    }, bug) as T
  }

  async createTestCase<T>(name: string, description: string, testPlanId: string): Promise<T> {
    const testCase = {
      "Name": name,
      "Project": { "Id": this.projectId },
      "Description": description,
      "TestPlans": [{
        "Id": testPlanId
      }],
    }

    return this.post<any, T>({
      pathParam: ["testCases"],
      param: { "format": "json" },
    }, testCase) as T
  }

  async createTestPlan<T>(title: string, resourceId: string, resourceType: 'UserStory' | 'Bug' | 'Feature' = 'UserStory', options?: { description?: string; startDate?: string; endDate?: string }): Promise<T> {
    const testPlan: Record<string, any> = {
      "Name": `Test Plan: ${title}`,
      "Project": {
        "Id": this.projectId
      },
      "LinkedGeneral": {
        "ResourceType": "General",
        "Id": resourceId,
        "Name": title,
      },
      "LinkedAssignable": {
        "ResourceType": "Assignable",
        "Id": resourceId,
        "Name": title,
      },
    }

    if (resourceType === 'UserStory') {
      testPlan["LinkedUserStory"] = { "ResourceType": "UserStory", "Id": resourceId, "Name": title }
    } else if (resourceType === 'Bug') {
      testPlan["LinkedBug"] = { "ResourceType": "Bug", "Id": resourceId, "Name": title }
    } else if (resourceType === 'Feature') {
      testPlan["LinkedFeature"] = { "ResourceType": "Feature", "Id": resourceId, "Name": title }
    }

    if (options?.description) testPlan["Description"] = options.description
    if (options?.startDate) testPlan["StartDate"] = options.startDate
    if (options?.endDate) testPlan["EndDate"] = options.endDate

    return this.post<any, T>({
      pathParam: ["testPlans"],
      param: { "format": "json" },
    }, testPlan) as T
  }

  async getUser<T>(userId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["Users", userId],
      param: { "format": "json" },
    }) as T
  }

  async getUsers<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Users"],
      param: { "format": "json" },
    }) as T
  }

  async addCommentWithUser<T>(cardId: string, comment: string, user: LoggedUser): Promise<TpResult<T | null>> {
    const userAt = user ? `cc - <div>@user:${user.Email}[${user.FirstName} ${user.LastName}]&nbsp;</div>` : ''
    const commentContent = `${comment}\nn${userAt}`
    return this.addComment<T>(cardId, commentContent)
  }

  async addComment<T>(cardId: string, comment: string): Promise<TpResult<T | null>> {
    const ownerId = await this.ownerId()
    const commentData: Record<string, unknown> = {
      "Description": comment,
      "General": {
        "Id": cardId,
      },
    }
    if (ownerId) {
      commentData["Owner"] = {
        "Id": ownerId,
      }
    }

    return this.postRaw<any, T | null>({
      pathParam: ["Comments"],
      param: { "format": "json" },
    }, commentData)
  }

  async addTestStep<T>(testCaseId: string, testStep: { description: string, result: string }): Promise<T> {
    const testStepData = {
      "Description": testStep.description,
      "Result": testStep.result,
      "TestCase": { "Id": testCaseId },
    }

    return this.post<any, T>({
      pathParam: ["testSteps"],
      param: { "format": "json" },
    }, testStepData) as T
  }

  async getBugComments<T>(bugId: string, results: number = 25): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["Bugs", bugId, "Comments"],
      param: {
        "format": "json",
        "take": results,
      }
    }) as T

    return response
  }

  async getUserStoryComments<T>(userStoryId: string, results: number = 25): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["UserStories", userStoryId, "Comments"],
      param: {
        "format": "json",
        "take": results,
      }
    }) as T

    return response
  }

  async searchContainsNameText<T>({ text, entityType, take = 25 }: { text: string, entityType: TpEntityCollection, take?: number }): Promise<T> {
    return this.get<T>({
      pathParam: [entityType],
      param: {
        "format": "json",
        "take": take,
        "where": `Name contains ${tpString(text)}`,
        "include": "[Name, Description, Id, EntityState[Name], Project[Name], CustomFields]"
      },
    }) as T
  }

  async searchContainsDescriptionText<T>({ text, entityType, take = 50 }: { text: string, entityType: TpEntityCollection, take?: number }): Promise<T> {
    return this.get<T>({
      pathParam: [entityType],
      param: {
        "where": `Description contains ${tpString(text)}`,
        "format": "json",
        "take": take,
        "include": "[Name, Description, Id, EntityState[Name], Project[Name], CustomFields]",
      },
    }) as T
  }

  async getCurrentReleases<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Releases"],
      param: {
        "format": "json",
        "where": `IsCurrent eq 'true'`,
      },
    }) as T
  }

  async getReleaseUserStories<T>({ name, results = 50, withDescription = false }: { name: string, results?: number, withDescription?: boolean }): Promise<T> {
    const includeFilter = withDescription ? "[Name, Description, Id]" : "[Name, Id]"
    return this.get<T>({
      pathParam: ["UserStories"],
      param: {
        "format": "json",
        "take": results,
        "where": `Release.Name eq ${tpString(name)}`,
        "include": includeFilter,
      }
    }) as T
  }

  async getReleaseOpenUserStories<T>({ name, results = 100, withDescription = false }: { name: string, results?: number, withDescription?: boolean }): Promise<T> {
    const includeFilter = withDescription ? "[Name, Description, Id]" : "[Name, Id]"
    return this.get<T>({
      pathParam: ["UserStories"],
      param: {
        "format": "json",
        "take": results,
        "where": `Release.Name eq ${tpString(name)} and EntityState.Name ne 'Closed' and EntityState.Name ne 'Done' and EntityState.Name ne 'Passed Dev01  QA' and EntityState.Name ne 'Ready to Deploy to prod'`,
        "include": includeFilter,
      }
    }) as T
  }

  async getReleaseOpenBugs<T>({ name, results = 200, withDescription = false }: { name: string, results?: number, withDescription?: boolean }): Promise<T> {
    const includeFilter = withDescription ? "[Name, Description, Id]" : "[Name, Id]"
    return this.get<T>({
      pathParam: ["Bugs"],
      param: {
        "format": "json",
        "take": results,
        "where": `Release.Name eq ${tpString(name)} and EntityState.Name ne 'Closed' and EntityState.Name ne 'Done' and EntityState.Name ne 'Passed Dev01  QA' and EntityState.Name ne 'Ready to Deploy to prod'`,
        "include": includeFilter,
      }
    }) as T
  }

  async getReleaseBugs<T>({ name, results = 100, withDescription = false }: { name: string, results?: number, withDescription?: boolean }): Promise<T> {
    const includeFilter = withDescription ? "[Name, Description, Id]" : "[Name, Id]"
    return this.get<T>({
      pathParam: ["Bugs"],
      param: {
        "format": "json",
        "take": results,
        "where": `Release.Name eq ${tpString(name)}`,
        "include": includeFilter,
      }
    }) as T
  }

  async getReleaseFeatures<T>({ name, results = 50, withDescription = false }: { name: string, results?: number, withDescription?: boolean }): Promise<T> {
    const includeFilter = withDescription ? "[Name, Description, Id]" : "[Name, Id]"
    return this.get<T>({
      pathParam: ["Features"],
      param: {
        "format": "json",
        "take": results,
        "where": `Release.Name eq ${tpString(name)}`,
        "include": includeFilter,
      }
    }) as T
  }

  async getFeatureUserStories<T>(featureId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["features"],
      param: {
        "format": "json",
        "where": `(id==${featureId})`,
        "select": `{userStories}`,
      },
      apiVersion: this.v2
    }) as T
  }

  async getUserStoryBugs<T>(userStoryId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["userstories"],
      param: {
        "format": "json",
        "where": `(id==${userStoryId})`,
        "select": `{bugs}`,
      },
      apiVersion: this.v2
    }) as T
  }

  async getUserStoriesIdsByFeatureId<T>(featureId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["userstories"],
      param: {
        "format": "json",
        "where": `(Feature.Id==${featureId})`,
        "select": `{id}`,
      },
      apiVersion: this.v2
    }) as T
  }

  async getUserStoryTestPlan<T>(userStoryId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["userStories", userStoryId],
      param: {
        "format": "json",
        "select": `{id,storyName:name,linkedtestplan}`,
      },
      apiVersion: this.v2
    }) as T
  }

  async getCardTestPlan<T>(cardId: string, resourceType: 'UserStory' | 'Bug' | 'Feature' = 'UserStory'): Promise<T> {
    const pathMap = { UserStory: "userStories", Bug: "bugs", Feature: "features" }
    return this.get<T>({
      pathParam: [pathMap[resourceType], cardId],
      param: {
        "format": "json",
        "select": `{id,linkedtestplan}`,
      },
    }) as T
  }

  async getTestPlanTestCases<T>(testPlanId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["testPlans", testPlanId, "testcases"],
      param: { "format": "json" },
    }) as T
  }

  async getTestCaseSteps<T>(testCaseId: string): Promise<T> {
    return this.get<T>({
      pathParam: ["testCases", testCaseId, "teststeps"],
      param: { "format": "json" },
    }) as T
  }

  async getProjects<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Projects"],
      param: { "format": "json" },
    }) as T
  }

  async getProcessWorkflows<T>({ processId }: { processId?: string }): Promise<T> {
    return this.get<T>({
      pathParam: ["Process"],
      param: {
        "format": "json",
        "where": `id=(${processId})`,
        "select": `{Workflows}`
      },
      apiVersion: this.v2
    }) as T
  }

  async getUserStories<T>({ take = 100 }: { take?: number }): Promise<T> {
    return this.get<T>({
      pathParam: ["userStories"],
      param: {
        "format": "json",
        "take": take,
      },
      apiVersion: this.v2
    }) as T
  }

  async getProcesses<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Processes"],
      param: { "format": "json" },
    }) as T
  }

  async getTeamAssignments<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["TeamAssignments"],
      param: { "format": "json" },
    }) as T
  }

  async getTeams<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Teams"],
      param: { "format": "json" },
    }) as T
  }

  async getUserStoryWorkflows<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["workflow"],
      param: {
        "format": "json",
        "select": `{Id,Name,Process,EntityType,EntityStates.Select({Id,Name}) as EntityStates}`,
        "where": `(process.id=${this.processId} and entityType.name="userStory" and parentWorkflow=null)`,
        "take": "1",
      },
      apiVersion: this.v2
    }) as T
  }

  async getUserStoryWorkflowsWithSubStates<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["EntityState"],
      param: {
        "format": "json",
        "select": `{id,name,isInitial,isFinal,isDefaultFinal,isPlanned,workflow:{workflow.id,process:{workflow.process.id}},entityType:{entityType.name},subEntityStates:subEntityStates.Select({id,name,entityType:{entityType.name},isInitial,isFinal,isDefaultFinal,isPlanned})}`,
        "where": `(parentEntityState==null and workflow.process.id in [${this.processId}])`,
        "take": "1000",
      },
      apiVersion: this.v2
    }) as T
  }

  async getBugWorkflows<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["workflow"],
      param: {
        "format": "json",
        "select": `{Id,Name,Process,EntityType,EntityStates.Select({Id,Name}) as EntityStates}`,
        "where": `(process.id=${this.processId} and entityType.name="bug" and parentWorkflow=null)`,
        "take": "1",
      },
      apiVersion: this.v2
    }) as T
  }

  async getCardStatus<T>(cardId: string, resourceType: 'UserStory' | 'Bug' | 'Feature' = 'UserStory'): Promise<T> {
    const pathMap = { UserStory: 'userStory', Bug: 'bug', Feature: 'feature' }
    return this.get<T>({
      pathParam: [pathMap[resourceType]],
      param: {
        "select": `{Project:{Project.Id},EntityState:{EntityState.Id,EntityState.Name,EntityState.NextStates,EntityState.Workflow.Id as WorkflowId},TeamState:{ResponsibleTeam.Id,Team:{ResponsibleTeam.Team.Id,ResponsibleTeam.Team.Name},EntityState:{ResponsibleTeam.EntityState.Id,ResponsibleTeam.EntityState.Name,ResponsibleTeam.EntityState.Workflow.Id as WorkflowId}},AssignedTeams.Select({TeamAssignmentId:Id,Id:Team.Id,Name:Team.Name}) as Teams}`,
        "where": `(id=${cardId})`,
        "take": "1",
      },
      apiVersion: this.v2
    }) as T
  }

  async getContext<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["Context"],
      param: { "format": "json" }
    }) as T
  }

  async getInProgressTasksAndBugs(userId: string): Promise<{ tasks: Task[], bugs: Bug[] }> {
    const where = `(EntityState.Name eq 'In Progress') and (AssignedUser.Id eq ${userId})`
    const include = "[Id,Name,EntityState[Name],UserStory[Id,Name,Feature[Id,Name]]]"
    const param = { "format": "json", "where": where, "include": include, "orderByDesc": "ModifyDate" }

    const [tasks, bugs] = await Promise.all([
      this.get<TpResponse<Task>>({ pathParam: ["Tasks"], param }),
      this.get<TpResponse<Bug>>({ pathParam: ["Bugs"], param }),
    ])

    return {
      tasks: tasks?.Items ?? [],
      bugs: bugs?.Items ?? [],
    }
  }

  async getTask<T>(taskId: string): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["Tasks", taskId],
      param: {
        "format": "json",
        "include": "[Id,Name,UserStory[Id,Name,Feature[Id,Name]]]",
      }
    }) as T

    return response
  }

  async getBugWithRelations<T>(bugId: string): Promise<T> {
    const response = await this.get<T>({
      pathParam: ["Bugs", bugId],
      param: {
        "format": "json",
        "include": "[Id,Name,UserStory[Id,Name,Feature[Id,Name]]]",
      }
    }) as T

    return response
  }

  async createTask<T>({
    title,
    description,
    userStoryId,
    projectId,
    teamId,
    entityStateId,
  }: CreateTaskInputSchema): Promise<T> {
    const cardStatusResponse = await this.getCardStatus<TpResponseV2<CardStatus>>(userStoryId, "UserStory")
    const cardStatus = cardStatusResponse?.items?.[0]
    const inheritedProjectId = projectId || String(cardStatus?.project?.id || this.projectId)
    const inheritedTeamId = teamId
      || String(cardStatus?.teamState?.team?.id || cardStatus?.teams?.[0]?.id || this.teamId)

    const task: Record<string, any> = {
      "Name": title,
      "Project": {
        "Id": inheritedProjectId
      },
      "UserStory": {
        "Id": userStoryId
      },
    }

    if (description) {
      task["Description"] = description
    }
    if (inheritedTeamId) {
      task["assignedTeams"] = [{
        "team": {
          "id": inheritedTeamId
        }
      }]
    }
    if (entityStateId) {
      task["EntityState"] = { "Id": entityStateId }
    }

    return this.post<any, T>({
      pathParam: ["Tasks"],
      param: { "format": "json" },
    }, task) as T
  }

  async logTime<T>({
    entityId,
    entityType,
    hours,
    description,
    date,
  }: {
    entityId: string
    entityType: 'Task' | 'UserStory' | 'Bug'
    hours: number
    description?: string
    date?: string
  }): Promise<T> {
    const ownerId = await this.ownerId()
    if (!ownerId) return null as T

    const timestamp = date ? new Date(date).getTime() : Date.now()
    const body: Record<string, any> = {
      Spent: hours,
      Date: `/Date(${timestamp})/`,
      User: { Id: ownerId },
      Assignable: { Id: entityId, ResourceType: entityType },
    }
    if (description) body["Description"] = description

    return this.post<any, T>({
      pathParam: ["Times"],
      param: { "format": "json" },
    }, body) as T
  }

  async getMyTimeLogs<T>(take: number = 25): Promise<T> {
    const ownerId = await this.ownerId()
    if (!ownerId) return null as T

    return this.get<T>({
      pathParam: ["Times"],
      param: {
        "format": "json",
        "where": `User.Id eq ${ownerId}`,
        "include": "[Id,Spent,Date,Description,Assignable[Id,Name,ResourceType]]",
        "orderByDesc": "Date",
        "take": take,
      },
    }) as T
  }

  async getMyUserStories<T>({ state, take = 25, skip = 0 }: { state?: string, take?: number, skip?: number }): Promise<T> {
    const ownerId = await this.ownerId()
    if (!ownerId) return null as T

    const whereParts = [`AssignedUser.Id eq ${ownerId}`]
    if (state) whereParts.push(`EntityState.Name contains ${tpString(state)}`)

    return this.get<T>({
      pathParam: ["UserStories"],
      param: {
        "format": "json",
        "where": whereParts.join(' and '),
        "include": "[Id,Name,EntityState[Name],Effort,Project[Name],Feature[Id,Name],CreateDate,ModifyDate]",
        "orderByDesc": "ModifyDate",
        "take": take,
        "skip": skip,
      },
    }) as T
  }

  async getMyBugs<T>({ state, take = 25, skip = 0 }: { state?: string, take?: number, skip?: number }): Promise<T> {
    const ownerId = await this.ownerId()
    if (!ownerId) return null as T

    const whereParts = [`AssignedUser.Id eq ${ownerId}`]
    if (state) whereParts.push(`EntityState.Name contains ${tpString(state)}`)

    return this.get<T>({
      pathParam: ["Bugs"],
      param: {
        "format": "json",
        "where": whereParts.join(' and '),
        "include": "[Id,Name,EntityState[Name],Severity[Name],Priority[Name],Project[Name],UserStory[Id,Name],CreateDate,ModifyDate]",
        "orderByDesc": "ModifyDate",
        "take": take,
        "skip": skip,
      },
    }) as T
  }

  // TP's Relations endpoint silently returns nothing for an OR across
  // Master.Id/Slave.Id, so we query each side separately and merge the results.
  async getCardRelations(cardId: string): Promise<TpResponse<Relation>> {
    const include = "[Id,RelationType[Name],Master[Id,Name,EntityType],Slave[Id,Name,EntityType]]"
    const query = (side: "Master" | "Slave") => this.get<TpResponse<Relation>>({
      pathParam: ["Relations"],
      param: {
        "format": "json",
        "where": `${side}.Id eq ${cardId}`,
        "include": include,
        "take": 100,
      },
    })

    const [asMaster, asSlave] = await Promise.all([query("Master"), query("Slave")])
    const items = [...(asMaster?.Items ?? []), ...(asSlave?.Items ?? [])]

    return { Next: "", Items: items }
  }

  async getRelationTypes<T>(): Promise<T> {
    return this.get<T>({
      pathParam: ["RelationTypes"],
      param: {
        "format": "json",
        "include": "[Id,Name]",
        "take": 100,
      },
    }) as T
  }

  // RelationType must be referenced by Id — passing it by Name makes TP try to
  // create a new RelationType resource, which returns 405 Method Not Allowed.
  async createRelation<T>({ masterId, slaveId, relationTypeId }: { masterId: string, slaveId: string, relationTypeId: string }): Promise<TpResult<T>> {
    const relation = {
      "Master": { "Id": masterId },
      "Slave": { "Id": slaveId },
      "RelationType": { "Id": relationTypeId },
    }

    return this.postRaw<any, T>({
      pathParam: ["Relations"],
      param: { "format": "json" },
    }, relation)
  }

  async deleteRelation<T>(relationId: string): Promise<TpResult<T>> {
    return this.del<T>({
      pathParam: ["Relations", relationId],
      param: { "format": "json" },
    })
  }

  async deleteCard<T>({
    cardId,
    nativeType,
  }: {
    cardId: string
    nativeType: TpNativeCardType
  }): Promise<TpResult<T>> {
    return this.del<T>({
      pathParam: [tpNativeTypeCollection(nativeType), cardId],
      param: { "format": "json" },
    })
  }

  async addCardTags<T>({
    cardId,
    labels,
    nativeType = "General",
  }: {
    cardId: string
    labels: string[]
    nativeType?: TpNativeCardType
  }): Promise<TpResult<T | null>> {
    const existing = await this.getInternalCard<{ Tags?: string }>(nativeType, cardId)
    const currentTags = (existing?.Tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)

    const mergedTags = [...currentTags]
    for (const label of labels.map((tag) => tag.trim()).filter(Boolean)) {
      if (!mergedTags.some((tag) => tag.toLowerCase() === label.toLowerCase())) {
        mergedTags.push(label)
      }
    }

    return this.postRaw<any, T | null>({
      pathParam: [tpNativeTypeCollection(nativeType)],
      param: { "format": "json" },
    }, {
      Id: cardId,
      Tags: mergedTags.join(", "),
    })
  }

  async addAttachedFile(generalId: string, source: { fileContent: string; fileName: string }): Promise<string | null> {
    const fileName = source.fileName
    const file = new File([Buffer.from(source.fileContent, "base64")], fileName)

    const formData = new FormData()
    formData.append("generalId", generalId)
    formData.append("file", file, fileName)

    const query: Record<string, string> = this.auth.kind === "accessToken" ? { access_token: this.auth.token } : {}
    const url = buildTargetprocessUrl(this.baseUrl, ["UploadFile.ashx"], query, { trailingSlash: false })
    this.debug("UPLOAD_URL", this.redactUrl(url))

    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: this.withAuthHeaders({}),
        body: formData,
      })
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      return await response.text()
    } catch (error) {
      console.error("Error uploading file:", error)
      return null
    }
  }
}
