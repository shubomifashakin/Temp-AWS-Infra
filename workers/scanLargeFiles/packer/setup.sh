#!/bin/bash
set -euxo pipefail

echo "=== Installing Node.js ==="
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
node --version

echo "=== Installing ClamAV ==="
sudo dnf install -y clamav clamav-update

echo "=== Updating virus definitions ==="
sudo freshclam

echo "=== Verifying ClamAV ==="
clamscan --version
echo "test file" > /tmp/test-clean.txt
clamscan /tmp/test-clean.txt
rm /tmp/test-clean.txt
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/test-eicar.txt
(clamscan /tmp/test-eicar.txt && echo "ERROR: EICAR should have been detected" && rm /tmp/test-eicar.txt && exit 1) || echo "EICAR detected - ClamAV working correctly"
rm /tmp/test-eicar.txt

echo "=== Installing scanner application ==="
sudo mkdir -p /opt/scanner
sudo cp -r /tmp/scanner-app/* /opt/scanner/
sudo chown -R ec2-user:ec2-user /opt/scanner

cd /opt/scanner
npm ci --omit=dev
npm install typescript
npm run build
npm uninstall typescript

echo "=== Installing systemd service ==="
sudo mkdir -p /etc/scanner
sudo cp /tmp/scanner.service /etc/systemd/system/scanner.service
sudo systemctl daemon-reload
sudo systemctl enable scanner

echo "=== AMI build complete ==="
