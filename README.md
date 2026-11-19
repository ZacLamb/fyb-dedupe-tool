# fyb-dedupe-tool (temporary)

One-off duplicate finder for the Fund Your Bizz GHL sub-account. No dependencies. Delete it when the cleanup is done.

## Deploy
1. New GitHub repo, upload these 3 files. New Railway service from that repo.
2. Railway variables:
   - `GHL_TOKEN`  new Private Integration token (scopes: contacts read; contacts write only if you want API deletes)
   - `LOCATION_ID`  ia4IJ2mcMhzJ0nKV7ajC
   - `ADMIN_KEY`  any long random string
3. Generate a domain.

## Use (send header `x-admin-key: <ADMIN_KEY>` or `?k=`)
- `POST /scan` pulls every contact and finds duplicate groups (takes a few minutes for ~96k).
- `GET /status` progress and counts.
- `GET /groups?conf=likely&offset=0&limit=200` groups as JSON.
- `POST /apply` with `{decisions:{...}, confirm:false}` is a dry run. Only `"delete"` decisions are executed via the API, and only with `confirm:true`. `"merge"` decisions are returned as a to-do list because GHL's API has no merge endpoint; do those in Contacts > Manage duplicates / the merge tool.

Data is held in memory only and is lost on restart.
