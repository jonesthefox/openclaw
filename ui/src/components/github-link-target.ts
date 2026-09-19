const GITHUB_URL_PREFIX = "https://github.com/";

type GitHubItemTarget = {
  kind: "issue" | "pull";
  number: number;
  owner: string;
  repo: string;
};

export type GitHubLinkTarget = GitHubItemTarget & {
  href: string;
};

export function decodeGitHubPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
}

export function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return host === "github.com" || host === "www.github.com";
}

export function parseGitHubItemPath(url: URL): GitHubItemTarget | null {
  // Match the actual pathname, never a resource embedded in an auth redirect or
  // an arbitrary suffix. These PR subviews still identify the same resource.
  const match =
    /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d{0,9})(?:\/(files|commits|checks)(?:\/([a-fA-F\d]{7,40}))?)?\/?$/u.exec(
      url.pathname,
    );
  if (!match || (match[3] === "issues" && match[5]) || (match[6] && match[5] !== "commits")) {
    return null;
  }
  const owner = decodeGitHubPathSegment(match[1]!);
  const repo = decodeGitHubPathSegment(match[2]!);
  if (
    !owner ||
    !/^(?=.{1,39}$)[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner) ||
    !repo ||
    !/^[a-z\d._-]{1,100}$/i.test(repo) ||
    /\.(?:git|atom)$/i.test(repo)
  ) {
    return null;
  }
  return { kind: match[3] === "issues" ? "issue" : "pull", number: Number(match[4]), owner, repo };
}

export function parseGitHubLinkTarget(href: string): GitHubLinkTarget | null {
  let url: URL;
  try {
    // Anchors resolve relative links; the stream scanner supplies absolute URLs.
    url = new URL(href);
  } catch {
    return null;
  }
  // Match the parsed URL so credentials, ports, and lookalike hosts cannot pass.
  if (!url.href.startsWith(GITHUB_URL_PREFIX)) {
    return null;
  }
  const target = parseGitHubItemPath(url);
  return target ? { ...target, href: url.href } : null;
}
