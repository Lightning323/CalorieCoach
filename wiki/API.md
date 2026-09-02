# REST API reference

The REST API exposes the configured account's nutrition data in JSON. All endpoints are read-only and return a top-level `data` object on success.

Base URL: `http://localhost:8080/api/v1`

## Authentication and browser access

Set `CALORIE_COACH_API_KEY` in the server environment to protect the API. When configured, clients must send that exact value in the `X-API-Key` header. Requests without it receive `401 Unauthorized`.

The API sends `Access-Control-Allow-Origin: *` for its read-only routes, so browser-based integrations can call it. Do not run an unprotected instance on a public network: when no API key is set, the API is intentionally open for local development. The API also handles browser `OPTIONS` preflight requests.

```bash
curl http://localhost:8080/api/v1/nutrition/daily \
  -H "X-API-Key: your-secret"
```

## `GET /foods/current`

Returns the foods logged on the current calendar day, using the account's timezone. Foods are newest first. Each item includes the food's `foodNutrients` (per 100 g), its ranked `foodPortions`, and scaled nutrition. USDA-backed logs also include `portion`, which preserves the person-entered amount and unit plus the gram total used for the calculation.

```json
{
  "data": {
    "date": "2026-08-19",
    "timezone": "America/Boise",
    "foods": [
      {
        "id": "68a...",
        "loggedAt": "2026-08-19T16:45:00.000Z",
        "quantity": 2.36,
        "portion": {
          "amount": 2,
          "unit": "slice",
          "grams": 214,
          "source": "usda-food-portion"
        },
        "notes": "",
        "food": {
          "id": "68b...",
          "names": ["banana", "USDA banana, raw"],
          "foodPortions": [
            { "unit": "1 medium", "grams": 118, "rank": 1 },
            { "unit": "100 grams", "grams": 100, "rank": 2 }
          ],
          "foodNutrients": {
            "calories": 89,
            "protein": 1.1,
            "carbs": 22.8,
            "fat": 0.3
          }
        },
        "nutrition": {
          "calories": 210.04,
          "protein": 2.6,
          "carbs": 53.81,
          "fat": 0.71
        }
      }
    ],
    "totals": {
      "calories": 210,
      "protein": 2.6,
      "carbs": 54,
      "fat": 0.8
    }
  }
}
```

If a referenced food was deleted, `food` is `null` and the item's nutrition is zero unless CalorieCoach retained a backup copy with the log.

## `GET /nutrition/daily`

Returns nutrition totals and configured goals for a single day.

- `date` — optional calendar date in `YYYY-MM-DD`; defaults to today in the account timezone.

```bash
curl "http://localhost:8080/api/v1/nutrition/daily?date=2026-08-19"
```

```json
{
  "data": {
    "date": "2026-08-19",
    "timezone": "America/Boise",
    "totals": { "calories": 210, "protein": 2.6, "carbs": 54, "fat": 0.8 },
    "goals": {
      "maintenanceCalories": 2200,
      "calorieOffset": -300,
      "calorieTarget": 1900,
      "proteinGoal": 150
    }
  }
}
```

## `GET /nutrition/weekly`

Returns seven consecutive calendar days, including the requested end day, plus aggregate totals and goals. It is a rolling seven-day window, not a Monday-through-Sunday week.

- `endDate` — optional final calendar date in `YYYY-MM-DD`; defaults to today in the account timezone.

```bash
curl "http://localhost:8080/api/v1/nutrition/weekly?endDate=2026-08-19"
```

The response includes `startDate`, `endDate`, `days` (one entry per day), `totals`, and `goals`. Missing days are represented with zero totals.

## Errors

- `400` — a date parameter was not a real `YYYY-MM-DD` date.
- `401` — an API key is configured but the supplied `X-API-Key` is missing or incorrect.
- `404` — the configured account does not exist.
- `500` — the server could not read nutrition data.
