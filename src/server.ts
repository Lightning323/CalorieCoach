import express from "express";
import path from "path";
import http from "http";
import { Server } from "socket.io";
import { config } from "./config";
import { connectDB } from "./db";
import { Accounts } from "./utils/account-database";
import ApiController from "./controllers/apiController";
import FoodController from "./controllers/foodController";
import IndexController from "./controllers/indexController";

const app = express();
/* =========================
   Middleware
========================= */

// Parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "middlewares/views"));

// Static assets
app.use(express.static(path.join(__dirname, "middlewares/public")));


/* =========================
   Websocket
========================= */
const server = http.createServer(app); // Create an HTTP server instance
const io = new Server(server);         // Attach Socket.io to that server

// Socket.io connection handler
io.on('connection', (socket: any) => {
    console.log('A user connected:', socket.id);
    socket.on('disconnect', () => console.log('User disconnected'));
});

/* =========================
   Page Routes
========================= */
new IndexController().register(io, app);
new FoodController().register(app);
new ApiController().register(app);


//Retrieve the user's timezone from the client
app.post('/timezone', (req, res) => {
  const { timezone } = req.body;

  console.log('User timezone:', timezone);
  Accounts.setTimezone(config.defaultUsername, timezone);

  //response
  res.json({
    message: 'Timezone received!',
    timezone
  });
});



/* =========================
   OpenFoodFacts API
========================= */
app.get("/foodFactsAPI", (req, res) => {
  res.render("foodFactsAPI", {
    appVersion: config.appVersion,
    results: null, query: "",
  });
});


/* =========================
   Server Boot
========================= */

(async () => {
  await connectDB(); // 🔥 REQUIRED
  server.listen(config.port, () =>
    console.log("🚀 Socket.io server running on port " + config.port)
  );
})();
