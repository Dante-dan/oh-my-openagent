import { sharedGitHubReadTransport } from "./transport"
import { buildBatches, decodeBatch, parsePullRequest, type FingerprintBaseline, type FingerprintRow } from "./fingerprints.mjs"

export type PrCheck = { id: string; name: string; status: string; conclusion: string | null; required: boolean }
export type PrRemark = { id: string; author: string; updatedAt: string; url: string; kind: "comment" | "review" }
export type PrDetails = { state: string; mergeable: string; head: string; checks: PrCheck[] }
export type PrActivity = { remarks: PrRemark[] }

type RawRemark = { id: string; author?: { login: string }; updatedAt: string; url: string }
type RawCheck = { databaseId?: number; id: string; name?: string; context: string; status: string; state: string; conclusion: string | null; isRequired: boolean }
type QueryData = { repository?: { pullRequest?: {
  state: string; mergeable: string; headRefOid: string;
  commits?: { nodes: { commit: { statusCheckRollup?: { contexts: { pageInfo: { hasNextPage: boolean }; nodes: RawCheck[] } } } }[] };
  comments?: { nodes: RawRemark[] }; reviews?: { nodes: RawRemark[] };
  reviewThreads?: { nodes: { comments?: { nodes: RawRemark[] } }[] };
} } }

function prQuery(reference: string, fields: string): string {
  const { owner, repo, number } = parsePullRequest(reference)
  return `query { rateLimit { remaining resetAt } repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) { ${fields} } } }`
}

export class GitHubPrWatchHost {
  constructor(readonly transport = sharedGitHubReadTransport()) {}

  async actor(): Promise<string> {
    const user = await this.transport.rest<{ login: string }>("/user")
    if (typeof user.login !== "string" || !user.login) throw new Error("Cannot identify authenticated GitHub actor")
    return user.login
  }

  async fingerprints(references: string[], previous: FingerprintBaseline, now: number): Promise<FingerprintRow[]> {
    const rows: FingerprintRow[] = []
    for (const batch of buildBatches(references)) {
      const response = await this.transport.graphql(batch.query)
      rows.push(...decodeBatch(batch, response, previous, now).rows)
    }
    return rows
  }

  async details(reference: string): Promise<PrDetails> {
    const { number } = parsePullRequest(reference)
    const response = await this.transport.graphql<QueryData>(prQuery(reference, `state mergeable headRefOid commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
      ... on CheckRun { databaseId name status conclusion isRequired(pullRequestNumber:${number}) }
      ... on StatusContext { id context state isRequired(pullRequestNumber:${number}) }
    } } } } } }`))
    if (response.errors?.length) throw new Error("GitHub PR detail query failed")
    const pr = response.data?.repository?.pullRequest
    if (!pr) throw new Error("GitHub PR detail missing")
    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
    if (contexts?.pageInfo?.hasNextPage) throw new Error("GitHub check context pagination needs continuation")
    const checks = (contexts?.nodes ?? []).map((check: RawCheck): PrCheck => check.name
      ? { id: `run:${check.databaseId}`, name: check.name, status: check.status, conclusion: check.conclusion, required: check.isRequired }
      : { id: `status:${check.id}`, name: check.context, status: check.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: check.state, required: check.isRequired })
    return { state: pr.state, mergeable: pr.mergeable, head: pr.headRefOid, checks }
  }

  async activity(reference: string): Promise<PrActivity> {
    const response = await this.transport.graphql<QueryData>(prQuery(reference, `comments(last:100) { nodes { id author { login } updatedAt url } }
      reviews(last:100) { nodes { id author { login } updatedAt url } }
      reviewThreads(last:100) { nodes { comments(first:10) { nodes { id author { login } updatedAt url } } } }`))
    if (response.errors?.length) throw new Error("GitHub PR activity query failed")
    const pr = response.data?.repository?.pullRequest
    if (!pr) throw new Error("GitHub PR activity missing")
    const convert = (row: RawRemark, kind: PrRemark["kind"]): PrRemark => ({ id: row.id, author: row.author?.login ?? "deleted-account", updatedAt: row.updatedAt, url: row.url, kind })
    const remarks: PrRemark[] = [
      ...(pr.comments?.nodes ?? []).map((row: RawRemark) => convert(row, "comment")),
      ...(pr.reviews?.nodes ?? []).map((row: RawRemark) => convert(row, "review")),
      ...(pr.reviewThreads?.nodes ?? []).flatMap((thread) => (thread.comments?.nodes ?? []).map((row: RawRemark) => convert(row, "comment"))),
    ]
    return { remarks: [...new Map(remarks.map((row) => [row.id, row])).values()] }
  }
}
