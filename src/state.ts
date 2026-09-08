import type { PostmortemPhase } from "./types.js";

const transitions: Record<PostmortemPhase, readonly PostmortemPhase[]> = {
  IDLE: ["REQUESTED"],
  REQUESTED: ["RUNNING", "CAPTURED"],
  RUNNING: ["CAPTURED"],
  CAPTURED: ["IDLE"],
};

export class PostmortemState {
  phase: PostmortemPhase = "IDLE";

  move(next: PostmortemPhase): void {
    if (!transitions[this.phase].includes(next)) {
      throw new Error(`Invalid postmortem transition: ${this.phase} -> ${next}`);
    }
    this.phase = next;
  }
}
