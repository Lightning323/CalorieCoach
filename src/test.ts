import { CoachAI } from "./coachAI";
import { connectDB } from "./db";
async function main() {

 await connectDB(); // 🔥 REQUIRED

  const result = await CoachAI.logFood(
    "testuser",
    "1 lime fruit strip",
    (progress: { progress: number; message: string }) => {
      console.log(`Progress: ${progress.progress}% - ${progress.message}`);
    },
  );

  console.log("Food log result:", result);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
