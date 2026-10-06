import { describe, expect, test } from "bun:test"
import { GitHubReadDeferred, GitHubReadTransport } from "./transport"

function replay(lines: string) {
  const responses = lines.trim().split("\n").map(line => JSON.parse(line) as { status: number; headers?: Record<string, string>; body?: unknown })
  const calls: { url: string; headers: Headers; body?: unknown }[] = []
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body && JSON.parse(String(init.body)) })
    const row = responses.shift()
    if (!row) throw new Error("Unexpected replay request")
    return new Response(row.body === undefined ? null : JSON.stringify(row.body), { status: row.status, headers: row.headers })
  }) as typeof fetch
  return { request, calls }
}

// #9493 asks for one shared transport, authentication precedence, budgets and ETag behavior.
describe("shared GitHub PR watch transport", () => {
  test("REST and GraphQL share explicit token precedence and never invoke gh auth", async () => {
    const fixture = replay('{"status":200,"body":{"login":"alice"}}\n{"status":200,"body":{"data":{"viewer":{"login":"alice"}}}}')
    let authentications = 0
    const transport = new GitHubReadTransport({ env: { GH_TOKEN: " preferred ", GITHUB_TOKEN: "secondary" }, fetch: fixture.request, authToken: async () => { authentications++; return "fallback" } })
    await transport.rest("/user"); await transport.graphql("query { viewer { login } }")
    expect(authentications).toBe(0)
    expect(fixture.calls.every(call => call.headers.get("authorization") === "Bearer preferred")).toBe(true)
    expect(fixture.calls.map(call => call.url)).toEqual(["https://api.github.com/user", "https://api.github.com/graphql"])
  })
  test("concurrent API reads resolve gh auth once per host and enterprise credentials stay separate", async () => {
    const fixture = replay('{"status":200,"body":{}}\n{"status":200,"body":{}}')
    let authentications = 0
    const transport = new GitHubReadTransport({ host: "git.example.com", env: { GH_TOKEN: "public-only" }, fetch: fixture.request, authToken: async host => { expect(host).toBe("git.example.com"); authentications++; return "enterprise" } })
    await Promise.all([transport.rest("/user"), transport.graphql("query { viewer { login } }")])
    expect(authentications).toBe(1)
    expect(fixture.calls.map(call => call.url)).toEqual(["https://git.example.com/api/v3/user", "https://git.example.com/api/graphql"])
    expect(fixture.calls.every(call => call.headers.get("authorization") === "Bearer enterprise")).toBe(true)
  })
  test("conditional REST read returns isolated cached JSON on 304", async () => {
    const fixture = replay('{"status":200,"headers":{"etag":"cached"},"body":{"login":"alice"}}\n{"status":304}')
    const transport = new GitHubReadTransport({ env: { GITHUB_TOKEN: "token" }, fetch: fixture.request })
    const first = await transport.rest<{ login: string }>("/user"); first.login = "modified"
    expect(await transport.rest("/user")).toEqual({ login: "alice" })
    expect(fixture.calls[1]!.headers.get("if-none-match")).toBe("cached")
  })
  test("primary GraphQL budget defers only GraphQL until reset; partial errors survive", async () => {
    let now = 1000
    const fixture = replay('{"status":200,"body":{"data":{"rateLimit":{"cost":2,"remaining":1,"resetAt":"1970-01-01T00:00:05Z"}},"errors":[{"path":["pr0"],"message":"Unavailable"}]}}\n{"status":200,"body":{"login":"alice"}}\n{"status":200,"body":{"data":{}}}')
    const transport = new GitHubReadTransport({ env: { GH_TOKEN: "token" }, fetch: fixture.request, now: () => now })
    const response = await transport.graphql("query1"); expect(response.errors?.length).toBe(1)
    await expect(transport.graphql("query2")).rejects.toBeInstanceOf(GitHubReadDeferred)
    expect(await transport.rest("/user")).toEqual({ login: "alice" })
    now = 5000; await transport.graphql("query2")
    expect(fixture.calls.length).toBe(3)
  })
  test("secondary limits defer both API surfaces and do not retry before deadline", async () => {
    let now = 1000
    const fixture = replay('{"status":403,"headers":{"retry-after":"2"},"body":{"message":"secondary rate limit"}}\n{"status":200,"body":{"data":{}}}')
    const transport = new GitHubReadTransport({ env: { GH_TOKEN: "token" }, fetch: fixture.request, now: () => now })
    await expect(transport.rest("/user")).rejects.toBeInstanceOf(GitHubReadDeferred)
    await expect(transport.graphql("query")).rejects.toBeInstanceOf(GitHubReadDeferred)
    expect(fixture.calls.length).toBe(1)
    now = 3000; await transport.graphql("query"); expect(fixture.calls.length).toBe(2)
  })
  test("ordinary permissions fail safely without a false rate-limit wait", async () => {
    const fixture = replay('{"status":403,"body":{"message":"private token-secret"}}\n{"status":200,"body":{}}')
    const transport = new GitHubReadTransport({ env: { GH_TOKEN: "token-secret" }, fetch: fixture.request })
    await expect(transport.rest("/user")).rejects.toThrow("GitHub read failed (403)")
    await transport.graphql("query"); expect(fixture.calls.length).toBe(2)
    await expect(transport.rest("//evil.example/user")).rejects.toThrow("Invalid GitHub REST path")
  })
})
