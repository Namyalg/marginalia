#!/usr/bin/env python3
"""Build an encrypted PDF fixture using PDFKit.

Sets an OWNER password but leaves the user password empty, which is the case
that actually matters: viewers (including pdf.js) open the file without
prompting, so the app can reach its save path with an encrypted document in
hand -- and must not overwrite the original.

Usage: make-encrypted.py <in.pdf> <out.pdf>
"""
import sys, json
from Quartz import PDFDocument, PDFDocumentOwnerPasswordOption
from Foundation import NSURL

def main(src, dst):
    doc = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(src))
    if doc is None:
        print(json.dumps({"error": "cannot open " + src})); return 2
    ok = doc.writeToFile_withOptions_(dst, {PDFDocumentOwnerPasswordOption: "owner-secret"})
    check = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(dst))
    print(json.dumps({
        "ok": bool(ok),
        "encrypted": bool(check.isEncrypted()) if check else None,
        "locked": bool(check.isLocked()) if check else None,
    }))
    return 0 if ok else 3

if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
