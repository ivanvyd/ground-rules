// Scrubbed reports in the shape subagents write. Names are invented.

/** A review report with a bad line number and a symbol that does not exist. */
export const REVIEW_REPORT = `## Findings

1. The session refresh is wired in \`src/auth/session.ts:212\`, where \`refreshGrant(\` is called after the token check.
2. Token parsing lives in src/auth/token.ts:10-24 and is covered by tests/auth/token.test.ts.
3. See also README.md and the notes at https://example.com/docs/auth.ts:99 (ignored).
4. \`parseToken\` returns early on empty input; \`true\` and \`config\` are not symbols.

No changes were made. Node.js 22 and v1.2.3 are mentioned for context only.
`

/** A report written on Windows, with every path spelling the parser meets there. */
export const WINDOWS_REPORT = `Checked these files:

- D:\\work\\api\\src\\Program.cs:41
- D:/work/api/src/Startup.cs#L12-L30
- /d/work/api/appsettings.json
- \\\\build\\share\\ci\\pipeline.yml:7
- .\\src\\Models\\User.cs:3:9
`
