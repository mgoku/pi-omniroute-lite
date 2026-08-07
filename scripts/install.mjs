#!/usr/bin/env node
/**
 * Copies the extension into pi's global extensions directory so it is
 * auto-discovered (and hot-reloadable with /reload).
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.PI_HOME ?? homedir();
const destDir = join(home, ".pi", "agent", "extensions");
const src = new URL("../omniroute.ts", import.meta.url);

mkdirSync(destDir, { recursive: true });
copyFileSync(src, join(destDir, "omniroute.ts"));

console.log(`✅ Copied omniroute.ts -> ${destDir}/omniroute.ts`);
console.log("Restart pi or run /reload to activate.");
