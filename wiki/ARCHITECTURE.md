# Architecture guide

## Application flow

`src/server.ts` configures Express, Socket.IO, static assets, and application startup. It registers controllers instead of holding route logic itself.

- `src/controllers/indexController.ts` owns the server-rendered dashboard, goal changes, food-log edits, and the background Socket.IO food logger.
- `src/controllers/foodController.ts` owns create, update, and delete operations for food database records.
- `src/controllers/apiController.ts` owns the versioned, read-only REST API and its API-key/CORS policy.
- `src/services/nutrition-service.ts` resolves active food logs and calculates daily and rolling-week nutrition. Both REST endpoints use this service so their totals are consistent.
- `src/utils/account-database.ts` and `src/utils/food-database.ts` are the persistence boundary for MongoDB.

## Nutrition lifecycle

Active food logs live in the account's `foods` array. At the start of a new local day, the dashboard archives prior-day totals to `foodHistory` and clears old active logs. The nutrition service also reads any still-active prior-day logs, so API responses remain accurate if the dashboard has not been opened since midnight.

All calendar boundaries are evaluated in the account's configured timezone. Invalid or missing timezones safely fall back to UTC for API reads.

## Configuration

- `MONGODB_URI` (required) — MongoDB connection string.
- `GEMINI_API_KEY` (required for AI food logging) — Gemini API credential.
- `PORT` (optional) — HTTP/WebSocket port; defaults to `8080`.
- `DEFAULT_USERNAME` (optional) — account exposed by the current single-user application; defaults to `Lightning323`.
- `CALORIE_COACH_API_KEY` (recommended) — protects `/api/v1/*` using `X-API-Key`.

## Adding an endpoint

1. Put a new HTTP concern in a controller under `src/controllers`.
2. Put calculation or data-composition logic in a service under `src/services`.
3. Use the database utilities for MongoDB access rather than reaching into collections from views or route handlers.
4. Register the controller once in `src/server.ts`.
5. Document externally visible changes in `API.md` or this guide.

## Development utilities

API modules do not execute requests when imported. Call their exported functions from a route, service, or an explicit development script. `src/test.ts` remains a manual AI/database exercise rather than an automated test suite, so use it only against disposable development data.


## Calorie Coach food logging logic

1. Gather matching database entries, rank them.
2. Pass these database candidates to an AI, instructing it to choose relevant database matches, or generate search queries for new undocumented food items
3. Generate candidates for new food items from the undocumented food item’s search queries
4. Pass these candidates to the AI, instructing it to choose the best USDA food candidates, preferably with portions if possible
5. For all food items, Convert the user specified or implied units into one of the units within the food.
6. We ask the AI, for every food item, pick the closest relevant food portion for each food entry, update the quantity to accurately reflect this portion.
7. We tell the AI, if no portions that it needs are available for a particular food, or the portion would result in a vastly different quantity (2 tsp honey cant easily be converted into 0.001 cups), we prompt it to generate its own portion size for that particular food item,
8. We use an algorithm to determine if we should save this new portion in the database or not.
9. (The quantity multiplies this gram weight and should be tunable by the user, if the AI gets the quantity wrong we as the human can fix it ourselves, so we don't take quantity into account here)
10. Every food entry should at least have 1 portion. If a new food item has no portions, the AI estimates one
usually this looks something like 1 pancake =  X grams, 1 cup of coffee = X grams, and so on
11. The food items are logged to the food journal database


