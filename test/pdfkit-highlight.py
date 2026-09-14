#!/usr/bin/env python3
"""Create a reference highlight using PDFKit -- the framework macOS Preview is
built on. Used as ground truth to compare our own highlight geometry against.

Usage: pdfkit-highlight.py <in.pdf> <out.pdf> <text to highlight>
"""
import sys, json
from Quartz import (PDFDocument, PDFAnnotation, PDFAnnotationSubtypeHighlight,
                    kPDFDisplayBoxMediaBox)
from AppKit import NSColor
from Foundation import NSURL


def main(src, dst, needle):
    doc = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(src))
    if doc is None:
        print(json.dumps({"error": "could not open " + src})); return 2

    matches = doc.findString_withOptions_(needle, 0)
    if not matches:
        print(json.dumps({"error": "text not found: " + needle})); return 3

    yellow = NSColor.colorWithSRGBRed_green_blue_alpha_(1.0, 0.90, 0.20, 1.0)
    written = []
    for sel in matches:
        # PDFKit itself splits a selection into one highlight per line.
        for line in (sel.selectionsByLine() or [sel]):
            for page in (line.pages() or []):
                b = line.boundsForPage_(page)
                ann = PDFAnnotation.alloc().initWithBounds_forType_withProperties_(
                    b, PDFAnnotationSubtypeHighlight, None)
                ann.setColor_(yellow)
                page.addAnnotation_(ann)
                written.append({
                    "page": doc.indexForPage_(page),
                    "rect": [round(b.origin.x, 2), round(b.origin.y, 2),
                             round(b.size.width, 2), round(b.size.height, 2)],
                })
        break  # first match only, to keep the comparison unambiguous

    doc.writeToFile_(dst)
    print(json.dumps({"ok": True, "annotations": written}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
