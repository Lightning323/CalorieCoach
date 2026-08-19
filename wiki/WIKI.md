# CalorieCoach Wiki

This wiki documents how to run, extend, and integrate with CalorieCoach.

- [API reference](API.md) — read the current foods, daily nutrition, and weekly nutrition through REST.
- [Architecture guide](ARCHITECTURE.md) — where routes, services, persistence, realtime updates, and views live.

## Quick start

1. Configure `MONGODB_URI` and `GEMINI_API_KEY` in `.env`.
2. Run `npm start`.
3. Open `http://localhost:8080` for the web app or use the API at `http://localhost:8080/api/v1`.

The current account is controlled by `DEFAULT_USERNAME`; it falls back to `Lightning323` for compatibility with the existing app data. Set `CALORIE_COACH_API_KEY` before exposing the REST API outside a trusted environment.
