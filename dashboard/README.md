# WeCom Candidate Dashboard

Local preview dashboard for WeCom candidate conversations.

Put server snapshot files in this directory:

```text
dashboard/data/history-*.json
dashboard/data/candidate-assessments.json
```

Run locally:

```bash
node dashboard/server.cjs
```

Open:

```text
http://127.0.0.1:19100/
```

The JSON data files are ignored by git so candidate data stays local.
