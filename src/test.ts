import { CoachAI } from "./coachAI";

async function main() {
  const result = await CoachAI.logFood(
    "testuser",
    "2 slices of pizza, 1 candy bar, 150 g chicken breast",
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
