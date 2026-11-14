export function completePRCheckGraphQLResponse(
  number: number,
  head: string,
  contexts: Record<string, unknown>[] = []
): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number,
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: head,
                    statusCheckRollup: {
                      contexts: {
                        nodes: contexts,
                        pageInfo: { hasNextPage: false, endCursor: null }
                      }
                    },
                    checkSuites: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
                  }
                }
              ]
            }
          }
        }
      }
    })
  }
}
