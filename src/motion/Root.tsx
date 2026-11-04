import React from "react";
import { Composition } from "remotion";
import { Ad, type AdProps } from "./Ad.js";

const FPS = 30;

export const Root: React.FC = () => (
  <Composition
    id="Ad"
    component={Ad as unknown as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={FPS}
    durationInFrames={FPS * 15}
    defaultProps={{} as Record<string, unknown>}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.round((props as unknown as AdProps).total * FPS) })}
  />
);
