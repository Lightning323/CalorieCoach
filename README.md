
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
* **Intelligent Food Estimation:** Leverages the **Gemini API** to provide caloric estimates for complex meals or prepared foods where direct database matches are unavailable.
* **Global Product Search:** Integrates the **Open Food Facts API** to retrieve real calorie and nutritional data.
* **Global food database:** The app combines disparate data sources into a unified, user-editable food database. This database is public and grows with every new food you eat.



## Installation & Configuration

### Database
It is recommended to host your database through MongoDB directly:
https://www.mongodb.com/

### Set up Environment Variables:
 Create a `.env` file in the root directory and add the following:
 ```env
 MONGO_DB_URL=your_mongodb_connection_string
 GEMINI_API_KEY=your_google_ai_api_key
```

### APIs
#### Open Food Facts API
https://github.com/openfoodfacts/openfoodfacts-js
No API is required here

#### Getting started with Gemini API
https://ai.google.dev/gemini-api/docs/quickstart
You will want to obtain an API key. Enter it in your `.env` file
