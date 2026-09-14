#!/usr/bin/env python3
"""Enumerate a PDF's annotations through PDFKit -- the exact framework macOS
Preview uses. If an annotation shows up here with the right subtype and bounds,
Preview will treat it as editable markup.

Usage: verify-pdfkit.py <file.pdf>   ->  JSON on stdout
"""
import json, sys
from Quartz import PDFDocument
from Foundation import NSURL

def main(path):
    url = NSURL.fileURLWithPath_(path)
    doc = PDFDocument.alloc().initWithURL_(url)
    if doc is None:
        print(json.dumps({"error": "PDFKit could not open the file"}))
        return 2
    out = {"pages": doc.pageCount(), "encrypted": bool(doc.isEncrypted()),
           "locked": bool(doc.isLocked()), "annotations": []}
    for i in range(doc.pageCount()):
        page = doc.pageAtIndex_(i)
        for a in (page.annotations() or []):
            b = a.bounds()
            rec = {
                "page": i,
                "type": str(a.type()) if a.type() else None,
                "rect": [round(b.origin.x, 2), round(b.origin.y, 2),
                         round(b.size.width, 2), round(b.size.height, 2)],
                "contents": a.contents(),
                "hasAppearance": a.appearanceStream() is not None
                                 if hasattr(a, "appearanceStream") else None,
            }
            try:
                rec["quadCount"] = len(a.quadrilateralPoints() or [])
            except Exception:
                pass
            out["annotations"].append(rec)
    print(json.dumps(out, indent=2, default=str))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
