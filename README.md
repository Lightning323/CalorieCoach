
# ![Logo](./src/middlewares/public/favicon_io/favicon-32x32.png) CalorieCoach
**An AI-Powered Calorie Tracking Application designed to simplify calorie counting!** Built on Node.js, Enter what you ate, and let AI do the rest!

![Built with](https://img.shields.io/badge/Built_With-NodeJS-blue)
![Powered By](https://img.shields.io/badge/Powered_By-Gemini_API-orange)

![img](./src/middlewares/public/Screenshot%202025-12-30%20130513.png)

<!-- # Calorie Ninja API
https://api-ninjas.com/profile
https://calorieninjas.com/api 
-->

## Key Features
* **Simple food tracking with AI:** Leverages the **Gemini API** to parse text into individual food entries. Gemini will use existing entries from the food database, or create **new food entries with estimated nutritional data** when no relavant database matches are found.
* **Global food database:** The app combines disparate data sources into a unified, user-editable food database. This database is public and grows with every new food you eat.
* **Ground-truth sources:** Integrates the **Open Food Facts API** to retrieve real calorie and nutritional data for easy adding into the food database.



## Installation & Configuration

### Database
It is recommended to host your database through MongoDB directly:
https://www.mongodb.com/

Obtain a connection string (URL) to your database, and place it into your `.env` file

### Set up Environment Variables:
 Create a `.env` file in the root directory and add the following:
 ```env
 MONGO_DB_URL=your_mongodb_connection_string
 GEMINI_API_KEY=your_google_ai_api_key
```

### APIs
#### Open Food Facts API
https://github.com/openfoodfacts/openfoodfacts-js

(No API key required!)

#### Getting started with Gemini API
https://ai.google.dev/gemini-api/docs/quickstart

Obtain an API key and enter it in your `.env` file as shown above
