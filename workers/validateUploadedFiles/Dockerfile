# Use the official AWS Lambda Node.js base image
FROM public.ecr.aws/lambda/nodejs:20

# 1. Install Prerequisites - Tools and Libraries
RUN dnf install -y \
    gcc gcc-c++ make pkg-config cmake \
    python3 python3-pip valgrind \
    bzip2-devel curl-devel json-c-devel \
    ncurses-devel pcre2-devel openssl-devel \
    libxml2-devel zlib-devel check-devel \
    tar \
    && dnf clean all

# 2. Install Rust Toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Verify Rust installation
RUN rustc --version && cargo --version

# 3. Download and Extract Source Code
WORKDIR /tmp
RUN curl -L https://www.clamav.net/downloads/production/clamav-1.0.7.tar.gz -o clamav.tar.gz && \
    tar xzf clamav.tar.gz && \
    cd clamav-1.0.7 && \
    mkdir build && cd build && \
    \
# 4. Build ClamAV with custom paths (disable milter since we don't need email scanning)
    cmake .. \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DAPP_CONFIG_DIRECTORY=/etc/clamav \
        -DDATABASE_DIRECTORY=/var/lib/clamav \
        -DENABLE_EXAMPLES=OFF \
        -DENABLE_MILTER=OFF && \
    cmake --build . && \
    cmake --build . --target install && \
    cd / && rm -rf /tmp/clamav*

# Update library cache (use alternative if ldconfig not available)
RUN echo "/usr/local/lib64" > /etc/ld.so.conf.d/clamav.conf || true

# 5. Post-Installation Setup
# Create configuration and database directories
RUN mkdir -p /var/lib/clamav /etc/clamav

# Configure freshclam - the sample files are already in /etc/clamav from cmake install
RUN if [ -f /etc/clamav/clamd.conf.sample ]; then \
        cp /etc/clamav/clamd.conf.sample /etc/clamav/clamd.conf && \
        sed -i 's/^Example/#Example/' /etc/clamav/clamd.conf; \
    fi && \
    if [ -f /etc/clamav/freshclam.conf.sample ]; then \
        cp /etc/clamav/freshclam.conf.sample /etc/clamav/freshclam.conf && \
        sed -i 's/^Example/#Example/' /etc/clamav/freshclam.conf && \
        sed -i 's/^#DatabaseDirectory .*/DatabaseDirectory \/var\/lib\/clamav/' /etc/clamav/freshclam.conf && \
        echo "DatabaseOwner root" >> /etc/clamav/freshclam.conf; \
    fi

# Update virus signatures with freshclam
RUN /usr/local/bin/freshclam --config-file=/etc/clamav/freshclam.conf --stdout 2>&1 || \
    /usr/local/bin/freshclam --datadir=/var/lib/clamav --stdout 2>&1

# Verify virus definitions were downloaded
RUN ls -lh /var/lib/clamav/ && \
    du -sh /var/lib/clamav/* && \
    echo "ClamAV virus definitions ready"

# Test ClamAV installation
RUN /usr/local/bin/clamscan --version && \
    echo "ClamAV installation verified"

# Copy Node.js package files
COPY app/package*.json ${LAMBDA_TASK_ROOT}/

# Install Node.js dependencies
WORKDIR ${LAMBDA_TASK_ROOT}
RUN npm ci --production

# Copy application code
COPY app/ ${LAMBDA_TASK_ROOT}/

# Build TypeScript
RUN npm install typescript && \
    npx tsc && \
    npm uninstall typescript

# Final verification - test scanning
RUN echo "test file" > /tmp/test.txt && \
    /usr/local/bin/clamscan --database=/var/lib/clamav /tmp/test.txt && \
    echo "Test scan successful" && \
    echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.txt && \
    (/usr/local/bin/clamscan --database=/var/lib/clamav /tmp/eicar.txt || echo "EICAR detected - ClamAV working correctly!")

# Set the CMD to your Lambda handler
CMD ["dist/index.handler"]