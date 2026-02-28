import { invoke } from "@tauri-apps/api/core";

export async function cfListProblems() {
  return invoke("cf_list_problems");
}
