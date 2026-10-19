import os
import random

import gradio as gr
import numpy as np
import spaces
import torch
from diffusers import ChromaPipeline

MODEL_ID = "lodestones/Chroma1-HD"
MAX_SEED = np.iinfo(np.int32).max
MAX_IMAGE_SIZE = 2048

DEFAULT_NEGATIVE = (
    "low quality, ugly, unfinished, out of focus, deformed, disfigure, blurry, "
    "smudged, restricted palette, flat colors"
)

pipe = ChromaPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
if os.environ.get("CHROMA_CPU_OFFLOAD") == "1":
    pipe.enable_model_cpu_offload()
else:
    pipe.to("cuda")


def get_duration(prompt, negative_prompt, seed, randomize_seed, width, height,
                 guidance_scale, num_inference_steps, progress=None):
    # Roughly scale the ZeroGPU reservation with the amount of work requested.
    pixels = width * height / (1024 * 1024)
    return int(min(300, 15 + num_inference_steps * 1.0 * max(pixels, 0.25)))


@spaces.GPU(duration=get_duration)
def infer(prompt, negative_prompt, seed, randomize_seed, width, height,
          guidance_scale, num_inference_steps, progress=gr.Progress(track_tqdm=True)):
    if not prompt or not prompt.strip():
        raise gr.Error("Please enter a prompt.")
    if randomize_seed:
        seed = random.randint(0, MAX_SEED)
    generator = torch.Generator("cpu").manual_seed(int(seed))
    image = pipe(
        prompt=prompt,
        negative_prompt=negative_prompt or None,
        width=int(width),
        height=int(height),
        guidance_scale=float(guidance_scale),
        num_inference_steps=int(num_inference_steps),
        generator=generator,
    ).images[0]
    return image, seed


examples = [
    "A high-fashion close-up portrait of a blonde woman in clear sunglasses. The image uses a bold teal and red color split for dramatic lighting. The background is a simple teal-green. The photo is sharp and well-composed, and is designed for viewing with anaglyph 3D glasses for optimal effect. It looks professionally done.",
    "A cozy reading nook in a treehouse at dusk, warm lantern light, rain on the windows, detailed watercolor illustration",
    "A cyberpunk street market at night, neon signs reflected in puddles, cinematic 35mm photo, shallow depth of field",
    "An astronaut riding a horse across a field of sunflowers, oil painting in the style of the Dutch masters",
]

css = """
#col-container { margin: 0 auto; max-width: 960px; }
"""

with gr.Blocks(css=css, title="Chroma1-HD") as demo:
    with gr.Column(elem_id="col-container"):
        gr.Markdown(
            "# Chroma1-HD\n"
            "Text-to-image with [lodestones/Chroma1-HD](https://huggingface.co/lodestones/Chroma1-HD), "
            "an 8.9B-parameter model based on FLUX.1-schnell."
        )
        with gr.Row():
            prompt = gr.Textbox(
                label="Prompt",
                show_label=False,
                placeholder="Describe the image you want",
                lines=2,
                max_lines=6,
                scale=5,
            )
            run_button = gr.Button("Generate", variant="primary", scale=1)
        result = gr.Image(label="Result", show_label=False, format="png")

        with gr.Accordion("Advanced settings", open=False):
            negative_prompt = gr.Textbox(
                label="Negative prompt", value=DEFAULT_NEGATIVE, lines=2
            )
            with gr.Row():
                seed = gr.Slider(label="Seed", minimum=0, maximum=MAX_SEED, step=1, value=433)
                randomize_seed = gr.Checkbox(label="Randomize seed", value=True)
            with gr.Row():
                width = gr.Slider(label="Width", minimum=256, maximum=MAX_IMAGE_SIZE, step=32, value=1024)
                height = gr.Slider(label="Height", minimum=256, maximum=MAX_IMAGE_SIZE, step=32, value=1024)
            with gr.Row():
                guidance_scale = gr.Slider(label="Guidance scale", minimum=1.0, maximum=10.0, step=0.1, value=3.0)
                num_inference_steps = gr.Slider(label="Steps", minimum=1, maximum=60, step=1, value=40)

        gr.Examples(examples=examples, inputs=[prompt])

    gr.on(
        triggers=[run_button.click, prompt.submit],
        fn=infer,
        inputs=[prompt, negative_prompt, seed, randomize_seed, width, height,
                guidance_scale, num_inference_steps],
        outputs=[result, seed],
    )

if __name__ == "__main__":
    demo.launch()
