#!/usr/bin/env python3
"""Regenera _mirror-en.html a partir de index.html + _mirror-parts/overlay.html.

El espejo es la PdP polaca tal cual, con una barra que traduce los textos al inglés
para poder revisar el copy sin leer polaco. Antes era una COPIA a mano de index.html,
así que se quedaba desfasado en cuanto se tocaba la página. Ahora se regenera:

    python3 scalp/build-mirror.py

El diccionario vive en overlay.html (DICT). Si un texto nuevo no está ahí, sale en
polaco — que es el aviso de que falta traducirlo, no un error.
"""
import os, sys, re

BASE = os.path.dirname(os.path.abspath(__file__))
idx  = open(os.path.join(BASE, "index.html"), encoding="utf-8").read()
ovl  = open(os.path.join(BASE, "_mirror-parts", "overlay.html"), encoding="utf-8").read()

m = re.search(r"\n</body>\s*</html>\s*$", idx)
if not m:
    sys.exit("index.html no termina en </body></html>")

out = idx[:m.start()] + "\n" + ovl.rstrip() + "\n</body>\n</html>\n"
open(os.path.join(BASE, "_mirror-en.html"), "w", encoding="utf-8").write(out)

# Aviso: textos visibles del index que el diccionario no cubre todavía.
dic = set(re.findall(r'"((?:[^"\\]|\\.)+)"\s*:\s*"', ovl))
print("espejo regenerado: %d líneas · diccionario con %d entradas" % (len(out.split("\n")), len(dic)))
