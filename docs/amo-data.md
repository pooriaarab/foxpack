# What the foxpack add-on sends, and its AMO data declaration

The manifest declares `data_collection_permissions: { "required": ["none"] }`.
This page lists everything that the add-on in `extension/` sends out of the
browser, and why no AMO data type applies to it today.

## The rule we apply

AMO's add-on policies define data transmission as data that is "collected,
used, transferred, shared, or handled outside of the add-on or the local
browser". The manifest key `data_collection_permissions` names the data
types an add-on transmits, and `none` means it transmits none
([Firefox built-in consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)).

## What leaves the browser

Nothing. The add-on has no host permissions and makes no network request.

- The import page reads the export file with `File.arrayBuffer()` and parses
  it in the page. The pack stays in `browser.storage.local`.
- The export button makes a file with a `blob:` URL. The user saves it.
- `runtime.onMessageExternal` answers the extension `foxscope@pooriaarab`
  only, with accepted memories. That is a message to another add-on in the
  same browser, which the user installed; it does not leave the browser.
  foxscope's own listing must declare what foxscope sends.

## When this must change

If a later version sends any of this data to a server, the same change adds
the matching data types (`personalCommunications` for conversations,
`personallyIdentifyingInfo` and `healthInfo` for memories) and asks for consent before the first send.
