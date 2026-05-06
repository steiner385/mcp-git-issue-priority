// src/services/github-graphql.ts

export const LIST_ISSUES_WITH_PARENTS_QUERY = `
  query ListOpenIssuesWithParents($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, states: [OPEN]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          labels(first: 20) { nodes { name color description } }
          assignees(first: 10) { nodes { login } }
          parent { number state }
        }
      }
    }
  }
`;

export const LIST_ISSUES_QUERY = `
  query ListOpenIssues($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, states: [OPEN]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          state
          url
          createdAt
          updatedAt
          labels(first: 20) { nodes { name color description } }
          assignees(first: 10) { nodes { login } }
        }
      }
    }
  }
`;

export const GET_PR_STATUS_QUERY = `
  query GetPrStatus($owner: String!, $repo: String!, $prNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        number
        state
        merged
        mergeable
        autoMergeRequest { mergeMethod }
        headRefOid
        commits(last: 1) {
          nodes {
            commit {
              checkSuites(first: 10) {
                nodes {
                  checkRuns(first: 50) {
                    nodes { name conclusion status }
                  }
                }
              }
            }
          }
        }
        reviews(last: 50, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes {
            state
            author { login }
          }
        }
      }
    }
  }
`;

export const GET_REPO_LABELS_QUERY = `
  query GetRepoLabels($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      labels(first: 50) {
        nodes { name color description }
      }
    }
  }
`;

export interface GQLIssueNode {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: { nodes: Array<{ name: string; color: string; description: string | null }> };
  assignees: { nodes: Array<{ login: string }> };
  parent: { number: number; state: 'OPEN' | 'CLOSED' } | null;
}

export interface GQLListIssuesResponse {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GQLIssueNode[];
    };
  };
}

export interface GQLIssueNodeNoParent {
  number: number;
  title: string;
  body: string | null;
  state: 'OPEN' | 'CLOSED';
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: { nodes: Array<{ name: string; color: string; description: string | null }> };
  assignees: { nodes: Array<{ login: string }> };
}

export interface GQLListIssuesNoParentResponse {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GQLIssueNodeNoParent[];
    };
  };
}

export interface GQLPrStatusResponse {
  repository: {
    pullRequest: {
      number: number;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      merged: boolean;
      mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
      autoMergeRequest: { mergeMethod: string } | null;
      headRefOid: string;
      commits: {
        nodes: Array<{
          commit: {
            checkSuites: {
              nodes: Array<{
                checkRuns: {
                  nodes: Array<{ name: string; conclusion: 'SUCCESS' | 'FAILURE' | 'NEUTRAL' | 'CANCELLED' | 'TIMED_OUT' | 'ACTION_REQUIRED' | 'SKIPPED' | null; status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' }>;
                };
              }>;
            };
          };
        }>;
      };
      reviews: {
        nodes: Array<{ state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'; author: { login: string } | null }>;
      };
    } | null;
  };
}

export interface GQLLabelsResponse {
  repository: {
    labels: {
      nodes: Array<{ name: string; color: string; description: string | null }>;
    };
  };
}
