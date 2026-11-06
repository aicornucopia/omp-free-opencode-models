# Free OpenCode models for OMP

An OMP extension that registers an `opencode-free` provider using OpenCode's
anonymous `public` credential and a request-compatibility adapter. No OpenCode
account or API key is configured by this plugin. It leaves OMP's built-in
`opencode` provider and your stored credentials unchanged.

The extension discovers models from OpenCode's live catalog, includes only
zero-priced text-generation models, and uses OMP's native Chat Completions or
Responses transport as advertised by each model. It preserves context limits,
output limits, and text/image input capabilities.

The adapter supplies release-versioned client metadata, stable conversation
attribution, and a factual workspace environment block. OMP's real `bash` tool is
named `shell` on the wire, with calls translated back for OMP to execute. It does
not advertise tools that are unavailable in the session.

## Install

Requires OMP 18.16.0 or later.

From this checkout:

```sh
omp plugin link .
```

Restart OMP after linking. To try the extension without installing it:

```sh
omp --no-extensions -e ./index.ts --model opencode-free/big-pickle
```

No build or dependency installation is needed to load the extension in OMP.

## Use

List the available free models:

```sh
omp models opencode-free
```

Select one in OMP's model picker, or start a session with its full selector:

```sh
omp --model opencode-free/big-pickle
```

Model availability is controlled by OpenCode and can change. The extension fetches
the catalog and current CLI release metadata at startup; restart OMP to refresh
them. Models with unknown text prices, nonzero prices, or unsupported API routes
are excluded. Audio and video inputs are not exposed because this extension uses
OMP's text/image model interface.

## Service limits

OpenCode controls eligibility and service limits. `429 FreeUsageLimitError` can
indicate rejected client/request characteristics as well as exhausted allowance;
the message alone does not distinguish them. The extension surfaces service
errors without rotating conversation identities, retrying outside OMP's normal
behavior, or falling back to paid models. Keep OMP's normal coding tools enabled:
restricting tools changes the request OpenCode receives and can affect eligibility.

Review OpenCode's service and data-use policies before sending sensitive prompts.

## Develop

```sh
bun install --ignore-scripts
bun test
bun run typecheck
```
