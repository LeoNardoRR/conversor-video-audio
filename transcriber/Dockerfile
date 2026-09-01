FROM debian:bookworm-slim AS build

ARG WHISPER_CPP_VERSION=v1.8.6

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates cmake git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --branch "${WHISPER_CPP_VERSION}" --depth 1 https://github.com/ggml-org/whisper.cpp.git /src \
    && cmake -S /src -B /src/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_NATIVE=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /src/build --config Release --target whisper-server -j2

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 whisper \
    && mkdir -p /models \
    && chown -R whisper:whisper /models

COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server

USER whisper
EXPOSE 8080
