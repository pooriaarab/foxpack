// The foxpack event page. It answers SCENT requests from the foxscope
// extension (scent.list, scent.read) with the accepted memories. Any other
// extension gets the error of an add-on that is not installed. The import
// page does the rest.
import { scentListener } from "../src/index.ts";

browser.runtime.onMessageExternal.addListener(scentListener(browser.storage.local));
