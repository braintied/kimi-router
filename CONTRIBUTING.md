# Contributing

Use Node.js 20 or newer. Changes must keep the router dependency-free unless a
dependency has a concrete security or portability benefit.

Before opening a pull request, run:

```bash
npm run gate
npm run artifact:check
```

Tests must use fake credentials and isolated temporary files. Never use a live
credential, real account label, production state file, or billable upstream in
the automated suite. A routing change should include a regression test that
proves both the selected route and the routes that were deliberately skipped.
Use reserved/example labels and dummy secrets only. Every new provider error
needs a structured fixture plus a conservative unknown-error regression.

Documentation claims about provider behavior must cite current first-party
documentation and include the date last verified.
