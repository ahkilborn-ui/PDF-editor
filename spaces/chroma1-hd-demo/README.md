---
title: Chroma1-HD
emoji: 🎨
colorFrom: purple
colorTo: pink
sdk: gradio
sdk_version: 6.30.0
python_version: "3.12"
app_file: app.py
pinned: false
license: apache-2.0
short_description: Text-to-image with lodestones/Chroma1-HD
models:
  - lodestones/Chroma1-HD
---

# Chroma1-HD demo

A Gradio demo for [lodestones/Chroma1-HD](https://huggingface.co/lodestones/Chroma1-HD),
an 8.9B-parameter text-to-image model based on FLUX.1-schnell, run with diffusers'
`ChromaPipeline` on ZeroGPU.

## Deploy

1. Create a new Gradio Space on Hugging Face and select **ZeroGPU** hardware.
2. Push the contents of this folder (`README.md`, `app.py`, `requirements.txt`) to the Space repo.

## Run locally

```bash
pip install -r requirements.txt
python app.py
```

Needs `gradio` and `spaces` installed too (both are preinstalled on Spaces), plus a CUDA GPU with enough memory for the bf16 weights (~24 GB), or set
`CHROMA_CPU_OFFLOAD=1` to use model CPU offload on smaller cards.
