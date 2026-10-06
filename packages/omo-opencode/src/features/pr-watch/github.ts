import { execFile } from "node:child_process"
import { buildBatches, decodeBatch, parsePullRequest, type FingerprintBaseline, type FingerprintRow } from "./fingerprints.mjs"

export type PrCheck = { id: string; name: string; status: string; conclusion: string | null; required: boolean }
export type PrRemark = { id: string; author: string; updatedAt: string; url: string; kind: "comment" | "review" }
export type PrDetails = { state: string; mergeable: string; head: string; checks: PrCheck[] }
export type PrActivity = { remarks: PrRemark[] }

async function graphql(query: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      try {
        const parsed = JSON.parse(stdout)
        if (error && !parsed.errors) return reject(new Error("GitHub transport read failed"))
        resolve(parsed)
      } catch { reject(new Error("GitHub returned no readable JSON response")) }
    })
  })
}

function prQuery(reference: string, fields: string): string {
  const { owner, repo, number } = parsePullRequest(reference)
  return `query { rateLimit { remaining resetAt } repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${number}) { ${fields} } } }`
}

export class GitHubPrWatchHost {
  async fingerprints(references: string[], previous: FingerprintBaseline, now: number): Promise<FingerprintRow[]> {
    const rows: FingerprintRow[] = []
    for (const batch of buildBatches(references)) {
      const response = await graphql(batch.query)
      rows.push(...decodeBatch(batch, response, previous, now).rows)
    }
    return rows
  }

  async details(reference: string): Promise<PrDetails> {
    const { number } = parsePullRequest(reference)
    const response = await graphql(prQuery(reference, `state mergeable headRefOid commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes {
      ... on CheckRun { databaseId name status conclusion isRequired(pullRequestNumber:${number}) }
      ... on StatusContext { id context state isRequired(pullRequestNumber:${number}) }
    } } } } } }`))
    if (response.errors?.length) throw new Error("GitHub PR detail query failed")
    const pr = response.data?.repository?.pullRequest
    if (!pr) throw new Error("GitHub PR detail missing")
    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts
    if (contexts?.pageInfo?.hasNextPage) throw new Error("GitHub check context pagination needs continuation")
    const checks = (contexts?.nodes ?? []).map((check: Record<string, any>): PrCheck => check.name
      ? { id: `run:${check.databaseId}`, name: check.name, status: check.status, conclusion: check.conclusion, required: check.isRequired }
      : { id: `status:${check.id}`, name: check.context, status: check.state === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: check.state, required: check.isRequired })
    return { state: pr.state, mergeable: pr.mergeable, head: pr.headRefOid, checks }
  }

  async activity(reference: string): Promise<PrActivity> {
    const response = await graphql(prQuery(reference, `comments(last:100) { nodes { id author { login } updatedAt url } }
      reviews(last:100) { nodes { id author { login } updatedAt url } }
      reviewThreads(last:100) { nodes { comments(first:10) { nodes { id author { login } updatedAt url } } } }`))
    if (response.errors?.length) throw new Error("GitHub PR activity query failed")
    const pr = response.data?.repository?.pullRequest
    if (!pr) throw new Error("GitHub PR activity missing")
    const convert = (row: Record<string, any>, kind: PrRemark["kind"]): PrRemark => ({ id: row.id, author: row.author?.login ?? "deleted-account", updatedAt: row.updatedAt, url: row.url, kind })
    const remarks: PrRemark[] = [
      ...(pr.comments?.nodes ?? []).map((row: Record<string, any>) => convert(row, "comment")),
      ...(pr.reviews?.nodes ?? []).map((row: Record<string, any>) => convert(row, "review")),
      ...(pr.reviewThreads?.nodes ?? []).flatMap((thread: Record<string, any>) => (thread.comments?.nodes ?? []).map((row: Record<string, any>) => convert(row, "comment"))),
    ]
    return { remarks: [...new Map(remarks.map((row) => [row.id, row])).values()] }
  }
}
