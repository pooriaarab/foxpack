// The foxpack event page. It answers SCENT requests from the foxscope
// extension (scent.list, scent.read) with the accepted memories, and sends
// nothing to any other extension or page. The import page does the rest.
import { scentListener } from "../src/index.ts";

browser.runtime.onMessageExternal.addListener(scentListener(browser.storage.local));
