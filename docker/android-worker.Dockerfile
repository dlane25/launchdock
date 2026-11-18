# Android build worker: JDK 17 + Android SDK + Node 22 (+ optional Flutter).
FROM eclipse-temurin:17-jdk-jammy

ARG ANDROID_CMDLINE_TOOLS=11076708
ARG INSTALL_FLUTTER=false
ARG FLUTTER_VERSION=3.27.1

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/cache/gradle \
    npm_config_cache=/cache/npm \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/flutter/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip git ca-certificates xz-utils python3 build-essential file \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && corepack enable \
    && rm -rf /var/lib/apt/lists/*

# Android SDK. AGP downloads any other platforms / NDK versions a project needs (licenses are pre-accepted).
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS}_latest.zip \
    && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools \
    && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm /tmp/tools.zip \
    && yes | sdkmanager --licenses > /dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.1.12297006" "cmake;3.22.1"

RUN if [ "$INSTALL_FLUTTER" = "true" ]; then \
      git clone --depth 1 -b ${FLUTTER_VERSION} https://github.com/flutter/flutter.git /opt/flutter \
      && flutter config --no-analytics && flutter precache --android; \
    fi

WORKDIR /worker
COPY worker/ ./
VOLUME ["/cache"]
ENV PLATFORMS=android WORK_DIR=/tmp/launchdock-worker
CMD ["node", "src/index.js"]
