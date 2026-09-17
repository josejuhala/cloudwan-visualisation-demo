/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * example.js -- a baked-in Cloud WAN core network policy, embedded as a JS const
 * so "Load example" works over file:// (a sibling .json fetch would be blocked
 * by the browser's file:// CORS rules). Account IDs are placeholders.
 */
export const EXAMPLE_POLICY = {
  version: "2021.12",
  "core-network-configuration": {
    "vpn-ecmp-support": true,
    "asn-ranges": ["64512-64555"],
    "edge-locations": [
      { location: "us-east-1", asn: 64512 },
      { location: "eu-west-1", asn: 64513 },
    ],
  },
  segments: [
    {
      name: "prod",
      description: "Production workloads.",
      "require-attachment-acceptance": true,
      "isolate-attachments": true,
      "edge-locations": ["us-east-1", "eu-west-1"],
    },
    {
      name: "dev",
      description: "Development / test workloads.",
      "require-attachment-acceptance": false,
      "isolate-attachments": false,
      "edge-locations": ["us-east-1"],
    },
    {
      name: "shared-services",
      description: "Shared platform services reachable from other segments.",
      "require-attachment-acceptance": false,
      "isolate-attachments": false,
      // No edge-locations listed -> implicitly spans all edge locations.
    },
    {
      name: "security",
      description: "Centralized inspection / egress.",
      "require-attachment-acceptance": true,
      "isolate-attachments": true,
      "edge-locations": ["us-east-1", "eu-west-1"],
    },
  ],
  "segment-actions": [
    // shared-services is reachable from every other segment.
    {
      action: "share",
      mode: "attachment-route",
      segment: "shared-services",
      "share-with": "*",
    },
    // prod and dev can reach the security segment for inspection.
    {
      action: "share",
      mode: "attachment-route",
      segment: "security",
      "share-with": ["prod", "dev"],
    },
    // A static default route injected into the security segment.
    {
      action: "create-route",
      segment: "security",
      "destination-cidr-blocks": ["0.0.0.0/0"],
    },
  ],
  "attachment-policies": [
    {
      "rule-number": 100,
      "condition-logic": "and",
      conditions: [
        { type: "tag-value", operator: "equals", key: "env", value: "prod" },
        { type: "account-id", operator: "equals", value: "111122223333" },
      ],
      action: {
        "association-method": "constant",
        segment: "prod",
        "require-acceptance-tag-value": "true",
      },
    },
    {
      "rule-number": 200,
      "condition-logic": "or",
      conditions: [
        { type: "tag-value", operator: "equals", key: "env", value: "dev" },
        { type: "region", operator: "equals", value: "us-east-1" },
      ],
      action: {
        "association-method": "constant",
        segment: "dev",
      },
    },
    {
      "rule-number": 300,
      "condition-logic": "and",
      conditions: [
        { type: "tag-exists", key: "inspect" },
        { type: "attachment-type", operator: "equals", value: "vpc" },
      ],
      action: {
        "association-method": "constant",
        segment: "security",
      },
    },
  ],
};
