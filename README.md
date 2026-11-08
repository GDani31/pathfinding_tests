```
# CPU (no NVIDIA GPU)
uv venv
source .venv/bin/activate
uv pip install torch --index-url https://download.pytorch.org/whl/cpu
uv pip install transformers accelerate
python server.py
```

```
# NVIDIA GPU (CUDA 12.8, check your driver with nvidia-smi)
uv venv
source .venv/bin/activate
uv pip install torch --index-url https://download.pytorch.org/whl/cu128
uv pip install transformers accelerate
python server.py
```
